-- Instructor lanes: one assignment now holds N concurrent submission slots
-- (the student rows). Replay workers each take a distinct (assignment, lane) so
-- up to lane_count jobs run on one assignment in parallel.
--
-- Additive. The student pipeline and existing instructor tables are untouched
-- except for new defaulted columns.

alter table public.turnitin_instructor_assignments
  add column if not exists lane_count integer not null default 5;

alter table public.turnitin_instructor_slot_usage
  add column if not exists lane integer;

alter table public.jobs
  add column if not exists instructor_lane integer;

-- At most one OPEN usage row per (assignment, lane) — the hard guard against two
-- jobs landing on the same lane.
create unique index if not exists instructor_usage_open_lane_uniq
  on public.turnitin_instructor_slot_usage(assignment_id, lane)
  where freed_at is null;

-- ── claim_next_instructor_job: now assigns a free (assignment, lane) ────────────
create or replace function public.claim_next_instructor_job(p_worker_id text)
returns public.jobs
language plpgsql security definer set search_path = public
as $$
declare
  v_assignment_id uuid;
  v_lane          integer;
  v_job           public.jobs;
begin
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
  if v_job.id is null then return null; end if;

  -- Claim the lane. If another worker won it (partial-unique conflict), the row
  -- is not inserted; the worker verifies ownership and requeues if it lost.
  insert into public.turnitin_instructor_slot_usage(assignment_id, job_id, lane)
  values (v_assignment_id, v_job.id, v_lane)
  on conflict (assignment_id, lane) where freed_at is null do nothing;

  return v_job;
end $$;
revoke all on function public.claim_next_instructor_job(text) from public, anon, authenticated;
grant execute on function public.claim_next_instructor_job(text) to service_role;

-- ── owns_open_lane: worker checks it actually holds the lane it was given ───────
create or replace function public.instructor_job_owns_lane(p_job_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists(
    select 1 from public.turnitin_instructor_slot_usage
    where job_id = p_job_id and freed_at is null
  );
$$;
revoke all on function public.instructor_job_owns_lane(uuid) from public, anon, authenticated;
grant execute on function public.instructor_job_owns_lane(uuid) to service_role;
