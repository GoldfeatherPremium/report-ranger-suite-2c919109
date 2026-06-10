ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_slot_id_fkey;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_slot_id_fkey
  FOREIGN KEY (slot_id) REFERENCES public.turnitin_slots(id) ON DELETE SET NULL;