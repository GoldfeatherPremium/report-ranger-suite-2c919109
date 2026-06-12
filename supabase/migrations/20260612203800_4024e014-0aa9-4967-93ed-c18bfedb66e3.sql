DELETE FROM public.turnitin_slot_usage u WHERE NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = u.job_id);
DELETE FROM public.turnitin_instructor_slot_usage u WHERE NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = u.job_id);
ALTER TABLE public.turnitin_slot_usage DROP CONSTRAINT IF EXISTS turnitin_slot_usage_job_id_fkey;
ALTER TABLE public.turnitin_slot_usage ADD CONSTRAINT turnitin_slot_usage_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;
ALTER TABLE public.turnitin_instructor_slot_usage DROP CONSTRAINT IF EXISTS turnitin_instructor_slot_usage_job_id_fkey;
ALTER TABLE public.turnitin_instructor_slot_usage ADD CONSTRAINT turnitin_instructor_slot_usage_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;