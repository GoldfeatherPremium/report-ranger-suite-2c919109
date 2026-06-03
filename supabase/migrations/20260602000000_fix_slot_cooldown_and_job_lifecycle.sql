-- Fix slot cooldown accounting + job lifecycle (cancel / retry) + resume attempts.
--
-- Problems addressed:
--   H1  claim_next_job's cooldown gate only looked at submitted_at and never at
--       freed_at / turnitin_submission_id.  A slot used by a job that FAILED
--       BEFORE submitting anything to Turnitin stayed locked for the full
--       cooldown window, even though requeue_stuck_jobs / cancel set freed_at.
--       The watchdog's "free the slot" work was therefore inert.
--   M2  Resume jobs (already submitted, just polling for the similarity score)
--       incremented attempts on every claim, so a slow Turnitin score exhausted
--       max_attempts and failed an otherwise-healthy job.
--   --  cancel/retry from the web app could not free turnitin_slot_usage rows
--       (RLS is admin-only), so cancelling/retrying leaked the scarce slot.
--
-- Cooldown semantics after this migration:
--   A usage row blocks its slot only while, within the cooldown window, EITHER
--     • the row is still open (freed_at IS NULL — job actively using the slot), OR
--     • a document was actually submitted (turnitin_submission_id IS NOT NULL —
--       Turnitin's real 24h cooldown applies).
--   A row that was freed without ever submitting no longer blocks the slot.

-- ── claim_next_job: cooldown respects freed_at + submission, resume keeps attempts ──
CREATE OR REPLACE FUNCTION public.claim_next_job(p_worker_id text)
RETURNS public.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_slot_id uuid;
  v_job     public.jobs;
BEGIN
  -- ── Priority 1: resume a job already submitted to Turnitin ──────────────────
  -- The document is already there; we only need to poll for the similarity score.
  -- Do NOT assign a new slot, do NOT create a usage row, and (M2) do NOT increment
  -- attempts — polling is not a submission attempt.
  UPDATE public.jobs j
  SET status         = 'processing',
      worker_id      = p_worker_id,
      started_at     = now(),
      last_polled_at = now(),
      updated_at     = now()
  WHERE j.id = (
    SELECT id FROM public.jobs
    WHERE  status                 = 'queued'
      AND  turnitin_submission_id IS NOT NULL
      AND  slot_id                IS NOT NULL
      AND  (queued_at IS NULL OR queued_at <= now())   -- respect retry delay
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_job;

  IF v_job.id IS NOT NULL THEN
    RETURN v_job;
  END IF;

  -- ── Priority 2: fresh job — pick a free slot ─────────────────────────────────
  SELECT s.id INTO v_slot_id
  FROM   public.turnitin_slots   s
  JOIN   public.turnitin_accounts a ON a.id = s.account_id
  WHERE  s.is_active AND a.is_active
    AND  NOT EXISTS (
           SELECT 1 FROM public.turnitin_slot_usage u
           WHERE  u.slot_id      = s.id
             AND  u.submitted_at > now() - make_interval(hours => s.cooldown_hours)
             AND  (u.freed_at IS NULL OR u.turnitin_submission_id IS NOT NULL)
         )
  ORDER BY s.created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_slot_id IS NULL THEN RETURN NULL; END IF;

  UPDATE public.jobs j
  SET status         = 'processing',
      slot_id        = v_slot_id,
      worker_id      = p_worker_id,
      started_at     = now(),
      last_polled_at = now(),
      attempts       = j.attempts + 1,
      updated_at     = now()
  WHERE j.id = (
    SELECT id FROM public.jobs
    WHERE  status                 = 'queued'
      AND  turnitin_submission_id IS NULL   -- only fresh/unsubmitted jobs
      AND  (queued_at IS NULL OR queued_at <= now())
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_job;

  IF v_job.id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.turnitin_slot_usage(slot_id, job_id) VALUES (v_slot_id, v_job.id);
  RETURN v_job;
END $$;

REVOKE ALL ON FUNCTION public.claim_next_job(text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_next_job(text) TO service_role;


-- ── cancel_job: owner/admin cancels a job and frees its slot when safe ─────────
-- Frees the slot ONLY when no document was submitted (no real Turnitin cooldown
-- owed) and the job was not yet claimed by a worker (pending/queued).  For a
-- processing job we cannot stop the running browser, so we leave the slot to be
-- freed by the worker's own completion path to avoid a double-submit race.
CREATE OR REPLACE FUNCTION public.cancel_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_job public.jobs;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'job not found';
  END IF;
  IF v_job.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF v_job.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN;  -- already terminal
  END IF;

  UPDATE public.jobs
  SET status = 'cancelled', finished_at = now(), worker_id = NULL, updated_at = now()
  WHERE id = p_job_id;

  IF v_job.status IN ('pending', 'queued') AND v_job.turnitin_submission_id IS NULL THEN
    UPDATE public.turnitin_slot_usage
    SET freed_at = now()
    WHERE job_id = p_job_id AND freed_at IS NULL;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.cancel_job(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.cancel_job(uuid) TO authenticated, service_role;


-- ── retry_job: owner/admin requeues a failed/cancelled job as a fresh upload ───
-- Clears slot_id + turnitin_submission_id so the job takes the fresh-upload path
-- and is assigned a newly-claimed slot, and frees the prior usage row.
CREATE OR REPLACE FUNCTION public.retry_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_job public.jobs;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'job not found';
  END IF;
  IF v_job.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF v_job.status = 'processing' THEN
    RAISE EXCEPTION 'cannot retry a job that is currently processing';
  END IF;

  UPDATE public.turnitin_slot_usage
  SET freed_at = now()
  WHERE job_id = p_job_id AND freed_at IS NULL;

  UPDATE public.jobs
  SET status                 = 'queued',
      error                  = NULL,
      attempts               = 0,
      slot_id                = NULL,
      turnitin_submission_id = NULL,
      worker_id              = NULL,
      finished_at            = NULL,
      queued_at              = now(),
      updated_at             = now()
  WHERE id = p_job_id;
END $$;

REVOKE ALL ON FUNCTION public.retry_job(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.retry_job(uuid) TO authenticated, service_role;
