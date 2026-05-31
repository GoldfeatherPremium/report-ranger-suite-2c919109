-- Respect queued_at delay for resume jobs.
--
-- When a job that was already submitted to Turnitin times out waiting for the
-- similarity score, markJobFailed sets queued_at = now() + 15 min.  Without
-- this patch, Priority-1 in claim_next_job would immediately re-claim it
-- (queued_at was not checked), causing a rapid login loop.
--
-- Fix: add AND (queued_at IS NULL OR queued_at <= now()) to Priority-1 so
-- the job stays invisible to workers until the delay expires.

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
  -- Do NOT assign a new slot and do NOT create a new turnitin_slot_usage row.
  -- Only pick jobs whose retry delay (queued_at) has passed.
  UPDATE public.jobs j
  SET status         = 'processing',
      worker_id      = p_worker_id,
      started_at     = now(),
      last_polled_at = now(),
      attempts       = j.attempts + 1,
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
