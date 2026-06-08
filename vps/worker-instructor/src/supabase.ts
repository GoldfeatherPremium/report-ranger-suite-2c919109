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
  type: "click" | "clicktext" | "fill" | "press" | "goto" | "wait" | "waittext" | "scroll" | "upload";
  selector?: string;  // durable selector for replay
  frame?: number;     // frame index the element lived in
  text?: string;      // visible text of the element (for human readability / fallback)
  value?: string;     // fill value, url, ms, or a <<PLACEHOLDER>> resolved at replay
  key?: string;       // key name for "press"
  note?: string;      // free-form operator note
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
