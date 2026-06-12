-- Temporarily make all slots free for today (2026-06-12)
-- by bypassing the 24-hour cooldown in both claim functions.

CREATE OR REPLACE FUNCTION public.claim_next_job(p_worker_id text)
 RETURNS jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = 'public'
AS $function$
declare
  v_slot_id uuid;
  v_job     public.jobs;
  v_today   date;
begin
  v_today := current_date;

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

  -- Priority 2: fresh job — pick a slot that is currently free.
  -- On 2026-06-12: bypass the 24-hour cooldown entirely.
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
           v_today = '2026-06-12'::date
        or (select max(u2.freed_at) from public.turnitin_slot_usage u2 where u2.slot_id = s.id) is null
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


CREATE OR REPLACE FUNCTION public.claim_next_instructor_job(p_worker_id text)
 RETURNS jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = 'public'
AS $function$
declare
  v_assignment_id uuid;
  v_lane          integer;
  v_job           public.jobs;
  v_today         date;
begin
  v_today := current_date;

  -- Priority 1: resume a job already submitted to Turnitin (keep its lane).
  update public.jobs j
  set status = 'processing', worker_id = p_worker_id,
      started_at = now(), last_polled_at = now(), updated_at = now()
  where j.id = (
    select id from public.jobs
    where pipeline = 'instructor' and status = 'queued'
      and turnitin_submission_id is not null
      and instructor_assignment_id is not null
      and (queued_at is null or queued_at <= now())
    order by created_at limit 1 for update skip locked
  )
  returning * into v_job;
  if v_job.id is not null then return v_job; end if;

  -- Priority 2: fresh job — pick the longest-idle free (assignment, lane).
  -- On 2026-06-12: bypass the 24-hour cooldown entirely.
  select x.assignment_id, x.lane into v_assignment_id, v_lane
  from (
    select a.id as assignment_id, g.lane,
           (select coalesce(max(u2.freed_at), '1970-01-01'::timestamptz)
            from public.turnitin_instructor_slot_usage u2
            where u2.assignment_id = a.id and u2.lane = g.lane) as last_freed
    from public.turnitin_instructor_assignments a
    join public.turnitin_instructor_classes  c   on c.id = a.class_id
    join public.turnitin_instructor_accounts acc on acc.id = c.account_id
    cross join lateral generate_series(0, a.lane_count - 1) as g(lane)
    where a.is_active and c.is_active and acc.is_active
      and not exists (
        select 1 from public.turnitin_instructor_slot_usage u
        where u.assignment_id = a.id and u.lane = g.lane and u.freed_at is null
      )
      and (
        v_today = '2026-06-12'::date
        or (select coalesce(max(u2.freed_at), '1970-01-01'::timestamptz)
            from public.turnitin_instructor_slot_usage u2
            where u2.assignment_id = a.id and u2.lane = g.lane) <= now() - interval '24 hours'
      )
  ) x
  order by x.last_freed asc
  limit 1;

  if v_assignment_id is null then return null; end if;

  update public.jobs j
  set status = 'processing', instructor_assignment_id = v_assignment_id,
      instructor_lane = v_lane, worker_id = p_worker_id,
      started_at = now(), last_polled_at = now(),
      attempts = j.attempts + 1, updated_at = now()
  where j.id = (
    select id from public.jobs
    where pipeline = 'instructor' and status = 'queued'
      and turnitin_submission_id is null
      and (queued_at is null or queued_at <= now())
    order by created_at limit 1 for update skip locked
  )
  returning * into v_job;
  if v_job.id is not null then return v_job; end if;

  -- Claim the lane. If another worker won it (partial-unique conflict), the row
  -- is not inserted; the worker verifies ownership and requeues if it lost.
  insert into public.turnitin_instructor_slot_usage(assignment_id, job_id, lane)
  values (v_assignment_id, v_job.id, v_lane)
  on conflict (assignment_id, lane) where freed_at is null do nothing;

  return v_job;
end $function$;

GRANT EXECUTE ON FUNCTION public.claim_next_job(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_job(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_instructor_job(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_instructor_job(text) TO service_role;