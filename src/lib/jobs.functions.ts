import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const JobActionSchema = z.object({ jobId: z.string().uuid() });

async function assertCanManageJob(jobId: string, userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: job, error } = await supabaseAdmin
    .from("jobs")
    .select("id,user_id,status,pipeline,turnitin_submission_id")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!job) throw new Error("job not found");

  const { data: profile } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (job.user_id !== userId && !isAdmin) throw new Error("not authorized");

  return { supabaseAdmin, job };
}

export const cancelJobAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => JobActionSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, job } = await assertCanManageJob(data.jobId, context.userId);
    if (["completed", "failed", "cancelled"].includes(job.status)) return { ok: true };

    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("jobs")
      .update({ status: "cancelled", finished_at: now, worker_id: null, updated_at: now })
      .eq("id", data.jobId);
    if (error) throw new Error(error.message);

    if (["pending", "queued"].includes(job.status) && job.turnitin_submission_id == null) {
      await Promise.all([
        supabaseAdmin.from("turnitin_slot_usage").update({ freed_at: now }).eq("job_id", data.jobId).is("freed_at", null),
        supabaseAdmin.from("turnitin_instructor_slot_usage").update({ freed_at: now }).eq("job_id", data.jobId).is("freed_at", null),
      ]);
    }
    return { ok: true };
  });

export const retryJobAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => JobActionSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, job } = await assertCanManageJob(data.jobId, context.userId);
    if (job.status === "processing") throw new Error("cannot retry a job that is currently processing");

    const now = new Date().toISOString();
    await Promise.all([
      supabaseAdmin.from("turnitin_slot_usage").update({ freed_at: now }).eq("job_id", data.jobId).is("freed_at", null),
      supabaseAdmin.from("turnitin_instructor_slot_usage").update({ freed_at: now }).eq("job_id", data.jobId).is("freed_at", null),
    ]);

    const { error } = await supabaseAdmin.from("jobs").update({
      status: "queued",
      error: null,
      attempts: 0,
      slot_id: null,
      instructor_assignment_id: null,
      turnitin_submission_id: null,
      worker_id: null,
      finished_at: null,
      started_at: null,
      last_polled_at: null,
      queued_at: now,
      ai_report_status: job.pipeline === "instructor" ? "pending" : null,
      updated_at: now,
    }).eq("id", data.jobId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });