create or replace function public.claim_next_job(p_worker_id text)
returns public.jobs
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_slot_id uuid;
  v_job     public.jobs;
begin
  -- Priority 1: resume a job already submitted to Turnitin
  update public.jobs j
  set status         = 'processing',
      worker_id      = p_worker_id,
      started_at     = now(),
      last_polled_at = now(),
      updated_at     = now()
  where j.id = (
    select id from public.jobs
    where  pipeline               = 'student'
      and  status                 = 'queued'
      and  turnitin_submission_id is not null
      and  slot_id                is not null
      and  (queued_at is null or queued_at <= now())
    order by created_at
    limit 1
    for update skip locked
  )
  returning * into v_job;

  if v_job.id is not null then
    return v_job;
  end if;

  -- Priority 2: fresh job — pick a slot that is currently free AND either
  -- never used, or last used (freed) more than 24 hours ago.
  -- Order: never-used slots first, then oldest-freed.
  select s.id into v_slot_id
  from   public.turnitin_slots   s
  join   public.turnitin_accounts a on a.id = s.account_id
  where  s.is_active and a.is_active
    and  not exists (
           select 1 from public.turnitin_slot_usage u
           where  u.slot_id   = s.id
             and  u.freed_at is null
         )
    and  (
           (select max(u2.freed_at) from public.turnitin_slot_usage u2 where u2.slot_id = s.id) is null
        or (select max(u2.freed_at) from public.turnitin_slot_usage u2 where u2.slot_id = s.id) <= now() - interval '24 hours'
    )
  order by
    (select max(u3.freed_at) from public.turnitin_slot_usage u3 where u3.slot_id = s.id) asc nulls first
  limit 1
  for update skip locked;

  if v_slot_id is null then return null; end if;

  update public.jobs j
  set status         = 'processing',
      slot_id        = v_slot_id,
      worker_id      = p_worker_id,
      started_at     = now(),
      last_polled_at = now(),
      attempts       = j.attempts + 1,
      updated_at     = now()
  where j.id = (
    select id from public.jobs
    where  pipeline               = 'student'
      and  status                 = 'queued'
      and  turnitin_submission_id is null
      and  (queued_at is null or queued_at <= now())
    order by created_at
    limit 1
    for update skip locked
  )
  returning * into v_job;

  if v_job.id is null then return null; end if;

  insert into public.turnitin_slot_usage(slot_id, job_id) values (v_slot_id, v_job.id);
  return v_job;
end $function$;