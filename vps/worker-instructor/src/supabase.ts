import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  const missing = [!url && "SUPABASE_URL", !key && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean).join(", ");
  throw new Error(`Missing required env var(s): ${missing}. Set them in vps/worker-instructor/.env`);
}
assertServiceRoleKey(key);

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
});

function assertServiceRoleKey(k: string) {
  const parts = k.split(".");
  if (parts.length !== 3) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be the JWT service_role key, not a publishable key or placeholder");
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: string };
    if (payload.role !== "service_role") {
      throw new Error(`SUPABASE_SERVICE_ROLE_KEY is a ${payload.role ?? "unknown"} key; paste the service_role key instead`);
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a valid JWT service_role key");
    throw error;
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────
export type InstructorAccount = {
  id: string;
  label: string;
  email: string;
  login_url: string;
  password: string; // decrypted server-side
};

// A single recorded action in a learned flow / training step.
export type FlowAction = {
  type: "click" | "clicktext" | "clickany" | "clickif" | "clickbtn" | "clickrow" | "clicknth" | "fill" | "press" | "goto" | "wait" | "waittext" | "scroll" | "upload";
  selector?: string;   // durable selector for replay
  frame?: number;      // frame index the element lived in
  text?: string;       // visible text of the element (for human readability / fallback)
  value?: string;      // fill value, url, ms, row label, lane index, "a | b" alternatives, or a <<PLACEHOLDER>>
  actionText?: string; // clickrow: the in-row action link; clicknth: the match needle (e.g. "Display actions menu")
  key?: string;        // key name for "press"
  note?: string;       // free-form operator note
};

// Lightweight, handle-free element metadata persisted with each step.
export type ElementMeta = {
  i: number;
  frame: number;
  tag: string;
  type: string;
  text: string;
  id: string;
  name: string;
  selector: string;
};

// ── Account lookup ─────────────────────────────────────────────────────────────
export async function getInstructorAccount(label?: string): Promise<InstructorAccount> {
  let q = supabase
    .from("turnitin_instructor_accounts")
    .select("id,label,email,login_url,is_active,created_at")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1);
  if (label) q = supabase
    .from("turnitin_instructor_accounts")
    .select("id,label,email,login_url,is_active,created_at")
    .eq("is_active", true)
    .eq("label", label)
    .limit(1);

  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(label
      ? `No active instructor account labelled "${label}". Add one in Admin → Instructor.`
      : "No active instructor account found. Add one in Admin → Instructor first.");
  }
  const acc = data as { id: string; label: string; email: string; login_url: string };
  const { data: pwd, error: pErr } = await supabase.rpc("decrypt_instructor_account_password", { account: acc.id });
  if (pErr) throw pErr;
  return {
    id: acc.id, label: acc.label, email: acc.email, login_url: acc.login_url,
    password: pwd as unknown as string,
  };
}

// ── Training session + steps ────────────────────────────────────────────────────
export async function createSession(accountId: string, workerId: string, note?: string): Promise<string> {
  const { data, error } = await supabase
    .from("turnitin_training_sessions")
    .insert({ account_id: accountId, worker_id: workerId, note: note ?? null })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function finishSession(sessionId: string, status: "finished" | "aborted") {
  await supabase.from("turnitin_training_sessions").update({ status }).eq("id", sessionId);
}

// Uploads a screenshot PNG and returns its storage path + a long-lived signed URL.
export async function uploadScreenshot(sessionId: string, idx: number, png: Buffer): Promise<{ path: string; signedUrl: string | null }> {
  const path = `sessions/${sessionId}/${String(idx).padStart(3, "0")}.png`;
  const { error } = await supabase.storage.from("training").upload(path, png, {
    contentType: "image/png", upsert: true,
  });
  if (error) throw error;
  const { data } = await supabase.storage.from("training").createSignedUrl(path, 60 * 60 * 24 * 7); // 7 days
  return { path, signedUrl: data?.signedUrl ?? null };
}

// Uploads a captured download (e.g. a report PDF) to the training bucket so the
// operator can verify the real file, returning a signed URL.
export async function uploadDownload(sessionId: string, filename: string, buf: Buffer): Promise<string | null> {
  const path = `downloads/${sessionId}/${filename}`;
  const { error } = await supabase.storage.from("training").upload(path, buf, { upsert: true });
  if (error) { console.error("download upload:", error.message); return null; }
  const { data } = await supabase.storage.from("training").createSignedUrl(path, 60 * 60 * 24 * 7);
  return data?.signedUrl ?? null;
}

// Uploads a per-step RUN diagnostic screenshot to the training bucket.
export async function uploadDiag(jobId: string, label: string, buf: Buffer): Promise<string | null> {
  const path = `run/${jobId}/${label}.png`;
  const { error } = await supabase.storage.from("training").upload(path, buf, { contentType: "image/png", upsert: true });
  if (error) { console.error("diag upload:", error.message); return null; }
  const { data } = await supabase.storage.from("training").createSignedUrl(path, 60 * 60 * 24 * 7);
  return data?.signedUrl ?? null;
}

export async function recordStep(args: {
  sessionId: string; idx: number; pageUrl: string; pageTitle: string;
  screenshotPath: string; elements: ElementMeta[]; action: FlowAction | null;
  status: "captured" | "executed" | "failed"; result?: string;
}): Promise<void> {
  const { error } = await supabase.from("turnitin_training_steps").insert({
    session_id: args.sessionId,
    idx: args.idx,
    page_url: args.pageUrl,
    page_title: args.pageTitle,
    screenshot_path: args.screenshotPath,
    elements: args.elements as never,
    action: (args.action ?? null) as never,
    status: args.status,
    result: args.result ?? null,
  });
  if (error) throw error;
}

// ── Flows ───────────────────────────────────────────────────────────────────────
export async function saveFlow(accountId: string, name: string, steps: FlowAction[]): Promise<string> {
  const { data, error } = await supabase
    .from("turnitin_instructor_flows")
    .insert({ account_id: accountId, name, steps: steps as never, status: "draft" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function getActiveFlow(accountId: string): Promise<FlowAction[] | null> {
  const { data, error } = await supabase
    .from("turnitin_instructor_flows")
    .select("steps")
    .or(`account_id.eq.${accountId},account_id.is.null`)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? ((data as { steps: FlowAction[] }).steps ?? []) : null;
}

// ── Ops ─────────────────────────────────────────────────────────────────────────
export async function heartbeat(workerId: string, activeJobs: number) {
  await supabase.from("worker_health").upsert({
    worker_id: workerId, last_seen: new Date().toISOString(), active_jobs: activeJobs, status: "online",
  });
}

export async function log(workerId: string, level: "info" | "warn" | "error", message: string, metadata?: object) {
  await supabase.from("worker_logs").insert({
    worker_id: workerId, job_id: null, level, message, metadata: (metadata ?? null) as never,
  });
  console.log(`[${level}] ${message}`);
}

// ── RUN / replay mode ────────────────────────────────────────────────────────
export type Job = {
  id: string;
  user_id: string;
  original_name: string;
  source_path: string;
  attempts: number;
  max_attempts: number;
  instructor_assignment_id: string | null;
  instructor_lane: number | null;
  turnitin_submission_id: string | null;
  ai_report_status: string | null;
};

export type AssignmentInfo = {
  assignment_id: string;
  assignment_label: string;
  class_label: string;
  account: { id: string; label: string; email: string; login_url: string; password: string };
};

export async function logJob(workerId: string, jobId: string | null, level: "info" | "warn" | "error", message: string) {
  await supabase.from("worker_logs").insert({ worker_id: workerId, job_id: jobId, level, message, metadata: null as never });
  console.log(`[${level}] ${message}`);
}

export async function claimNextInstructorJob(workerId: string): Promise<Job | null> {
  const { data, error } = await supabase.rpc("claim_next_instructor_job", { p_worker_id: workerId });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Job | null | undefined;
  return row && row.id ? row : null;
}

export async function ownsLane(jobId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("instructor_job_owns_lane", { p_job_id: jobId });
  if (error) throw error;
  return data === true;
}

export async function getAssignmentInfo(assignmentId: string): Promise<AssignmentInfo> {
  const { data: a, error } = await supabase
    .from("turnitin_instructor_assignments")
    .select("id,label,class_id, turnitin_instructor_classes(id,label,account_id, turnitin_instructor_accounts(id,label,email,login_url))")
    .eq("id", assignmentId)
    .single();
  if (error) throw error;

  type Raw = {
    id: string; label: string;
    turnitin_instructor_classes: {
      id: string; label: string; account_id: string;
      turnitin_instructor_accounts: { id: string; label: string; email: string; login_url: string };
    };
  };
  const r = a as unknown as Raw;
  const acc = r.turnitin_instructor_classes.turnitin_instructor_accounts;
  const { data: pwd, error: pErr } = await supabase.rpc("decrypt_instructor_account_password", { account: acc.id });
  if (pErr) throw pErr;

  return {
    assignment_id: r.id,
    assignment_label: r.label,
    class_label: r.turnitin_instructor_classes.label,
    account: { id: acc.id, label: acc.label, email: acc.email, login_url: acc.login_url, password: pwd as unknown as string },
  };
}

export async function downloadSource(sourcePath: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from("documents").download(sourcePath);
  if (error || !data) throw error ?? new Error("source download failed");
  return Buffer.from(await data.arrayBuffer());
}

export async function uploadReport(
  userId: string, jobId: string, pdf: Buffer, kind: "similarity" | "ai",
): Promise<void> {
  const path = `${userId}/${jobId}.${kind}.pdf`;
  const { error } = await supabase.storage.from("reports").upload(path, pdf, {
    contentType: "application/pdf", upsert: true,
  });
  if (error) throw error;
  const { error: ins } = await supabase.from("reports").upsert({
    job_id: jobId, storage_path: path, file_name: `${jobId}.${kind}.pdf`,
    mime_type: "application/pdf", size_bytes: pdf.length, kind,
  }, { onConflict: "job_id,kind" });
  if (ins) throw ins;
}

export async function setAiReportStatus(jobId: string, status: "pending" | "ready" | "failed") {
  await supabase.from("jobs").update({ ai_report_status: status }).eq("id", jobId);
}

export async function markJobSubmitted(jobId: string, submissionId: string) {
  await supabase.from("jobs").update({
    turnitin_submission_id: submissionId, last_polled_at: new Date().toISOString(),
  }).eq("id", jobId);
}

export async function touchJob(jobId: string) {
  await supabase.from("jobs").update({ last_polled_at: new Date().toISOString() }).eq("id", jobId);
}

export async function markJobDone(jobId: string, submissionId: string | null, similarityPercent?: number | null) {
  await supabase.from("jobs").update({
    status: "completed", finished_at: new Date().toISOString(),
    turnitin_submission_id: submissionId, last_polled_at: new Date().toISOString(),
    ...(similarityPercent != null ? { similarity_percent: similarityPercent } : {}),
  }).eq("id", jobId);
  await supabase.from("turnitin_instructor_slot_usage")
    .update({ freed_at: new Date().toISOString(), turnitin_submission_id: submissionId })
    .eq("job_id", jobId).is("freed_at", null);
  await supabase.rpc("enqueue_job_callback", { p_job_id: jobId, p_event: "job.completed" });
}

export async function markJobFailed(jobId: string, attempts: number, max: number, error: string) {
  if (attempts >= max) {
    await supabase.from("jobs").update({
      status: "failed", finished_at: new Date().toISOString(), error, ai_report_status: "failed",
    }).eq("id", jobId);
    await supabase.rpc("enqueue_job_callback", { p_job_id: jobId, p_event: "job.failed" });
  } else {
    await supabase.from("jobs").update({
      status: "queued", error, instructor_assignment_id: null, instructor_lane: null,
      worker_id: null, queued_at: new Date().toISOString(),
    }).eq("id", jobId);
  }
  await supabase.from("turnitin_instructor_slot_usage")
    .update({ freed_at: new Date().toISOString() })
    .eq("job_id", jobId).is("freed_at", null);
}

export async function requeueJob(jobId: string, reason: string) {
  await supabase.from("turnitin_instructor_slot_usage")
    .update({ freed_at: new Date().toISOString() })
    .eq("job_id", jobId).is("freed_at", null);
  await supabase.from("jobs").update({
    status: "queued", error: reason, instructor_assignment_id: null, instructor_lane: null,
    worker_id: null, queued_at: new Date().toISOString(),
  }).eq("id", jobId);
}
