-- Enforce valid pipeline/report status values for all future job writes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_pipeline_valid'
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_pipeline_valid
      CHECK (pipeline IN ('student', 'instructor')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_ai_report_status_valid'
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_ai_report_status_valid
      CHECK (ai_report_status IS NULL OR ai_report_status IN ('pending', 'ready', 'failed')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reports_kind_valid'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_kind_valid
      CHECK (kind IN ('similarity', 'ai')) NOT VALID;
  END IF;
END $$;

-- Include pipeline/report-type information in callbacks at creation time.
CREATE OR REPLACE FUNCTION public.enqueue_job_callback(p_job_id uuid, p_event text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_job public.jobs;
  v_payload jsonb;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id;
  IF v_job.callback_url IS NULL THEN RETURN; END IF;

  v_payload := jsonb_build_object(
    'event',              p_event,
    'job_id',             v_job.id,
    'external_ref',       v_job.external_ref,
    'status',             v_job.status,
    'pipeline',           v_job.pipeline,
    'report_type',        CASE WHEN v_job.pipeline = 'instructor' THEN 'similarity_ai' ELSE 'similarity' END,
    'similarity_percent', v_job.similarity_percent,
    'ai_report_status',   v_job.ai_report_status,
    'finished_at',        v_job.finished_at,
    'error',              v_job.error,
    'metadata',           v_job.metadata
  );

  INSERT INTO public.job_callbacks(job_id, api_client_id, event, url, payload)
  VALUES (p_job_id, v_job.api_client_id, p_event, v_job.callback_url, v_payload);
END $$;

REVOKE ALL ON FUNCTION public.enqueue_job_callback(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_job_callback(uuid, text) TO service_role;

-- Cancel both pipeline types safely and free the correct live usage row.
CREATE OR REPLACE FUNCTION public.cancel_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'job not found';
  END IF;
  IF v_job.user_id <> auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF v_job.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN;
  END IF;

  UPDATE public.jobs
  SET status = 'cancelled', finished_at = now(), worker_id = NULL, updated_at = now()
  WHERE id = p_job_id;

  IF v_job.status IN ('pending', 'queued') AND v_job.turnitin_submission_id IS NULL THEN
    UPDATE public.turnitin_slot_usage
    SET freed_at = now()
    WHERE job_id = p_job_id AND freed_at IS NULL;

    UPDATE public.turnitin_instructor_slot_usage
    SET freed_at = now()
    WHERE job_id = p_job_id AND freed_at IS NULL;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.cancel_job(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cancel_job(uuid) TO authenticated, service_role;

-- Retry preserves the chosen pipeline but clears stale student slots or instructor assignments.
CREATE OR REPLACE FUNCTION public.retry_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs;
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

  UPDATE public.turnitin_instructor_slot_usage
  SET freed_at = now()
  WHERE job_id = p_job_id AND freed_at IS NULL;

  UPDATE public.jobs
  SET status                   = 'queued',
      error                    = NULL,
      attempts                 = 0,
      slot_id                  = NULL,
      instructor_assignment_id = NULL,
      turnitin_submission_id   = NULL,
      worker_id                = NULL,
      finished_at              = NULL,
      started_at               = NULL,
      last_polled_at           = NULL,
      queued_at                = now(),
      ai_report_status         = CASE WHEN pipeline = 'instructor' THEN 'pending' ELSE NULL END,
      updated_at               = now()
  WHERE id = p_job_id;
END $$;

REVOKE ALL ON FUNCTION public.retry_job(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.retry_job(uuid) TO authenticated, service_role;