-- Instructor pipeline: a second, fully independent Turnitin flow on instructor
-- accounts that produces TWO PDFs per document (Similarity + AI Writing).
--
-- Design: shares nothing at runtime with the student pipeline. Separate tables,
-- separate RPCs, separate worker process. The student flow is untouched except
-- for a `pipeline = 'student'` guard added to claim_next_job so it can never
-- accidentally grab an instructor job.
--
-- Everything here is additive: new tables, new nullable/defaulted columns, new
-- functions. Existing rows keep working (jobs default pipeline='student',
-- reports default kind='similarity').

-- ── Instructor accounts ───────────────────────────────────────────────────────
-- Mirrors turnitin_accounts. Reuses the shared encrypt_account_password().
create table public.turnitin_instructor_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  email text not null,
  password_encrypted bytea not null,
  login_url text not null default 'https://www.turnitin.com/login_page.asp?lang=en_us',
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.turnitin_instructor_accounts to authenticated;
grant all on public.turnitin_instructor_accounts to service_role;
alter table public.turnitin_instructor_accounts enable row level security;
create policy turnitin_instructor_accounts_admin_all on public.turnitin_instructor_accounts for all to authenticated
  using (is_admin()) with check (is_admin());
create trigger trg_turnitin_instructor_accounts_updated before update on public.turnitin_instructor_accounts
  for each row execute function public.set_updated_at();

-- ── Instructor classes ────────────────────────────────────────────────────────
-- A class is a container of assignments, NOT a bookable slot.
create table public.turnitin_instructor_classes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.turnitin_instructor_accounts(id) on delete cascade,
  label text not null,
  class_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_instructor_classes_account on public.turnitin_instructor_classes(account_id);
grant select, insert, update, delete on public.turnitin_instructor_classes to authenticated;
grant all on public.turnitin_instructor_classes to service_role;
alter table public.turnitin_instructor_classes enable row level security;
create policy turnitin_instructor_classes_admin_all on public.turnitin_instructor_classes for all to authenticated
  using (is_admin()) with check (is_admin());
create trigger trg_turnitin_instructor_classes_updated before update on public.turnitin_instructor_classes
  for each row execute function public.set_updated_at();

-- ── Instructor assignments ────────────────────────────────────────────────────
-- An assignment is the bookable "slot" (the analogue of turnitin_slots).
create table public.turnitin_instructor_assignments (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.turnitin_instructor_classes(id) on delete cascade,
  label text not null,
  submit_url text,
  cooldown_hours integer not null default 24,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_instructor_assignments_class on public.turnitin_instructor_assignments(class_id);
grant select, insert, update, delete on public.turnitin_instructor_assignments to authenticated;
grant all on public.turnitin_instructor_assignments to service_role;
alter table public.turnitin_instructor_assignments enable row level security;
create policy turnitin_instructor_assignments_admin_all on public.turnitin_instructor_assignments for all to authenticated
  using (is_admin()) with check (is_admin());
create trigger trg_turnitin_instructor_assignments_updated before update on public.turnitin_instructor_assignments
  for each row execute function public.set_updated_at();

-- ── Instructor slot usage ─────────────────────────────────────────────────────
-- Same role as turnitin_slot_usage, scoped to instructor assignments.
create table public.turnitin_instructor_slot_usage (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.turnitin_instructor_assignments(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  freed_at timestamptz,
  turnitin_submission_id text
);
create index idx_instructor_usage_assignment_time on public.turnitin_instructor_slot_usage(assignment_id, submitted_at desc);
create index idx_instructor_usage_job on public.turnitin_instructor_slot_usage(job_id);
grant select, insert, update, delete on public.turnitin_instructor_slot_usage to authenticated;
grant all on public.turnitin_instructor_slot_usage to service_role;
alter table public.turnitin_instructor_slot_usage enable row level security;
create policy turnitin_instructor_slot_usage_admin_all on public.turnitin_instructor_slot_usage for all to authenticated
  using (is_admin()) with check (is_admin());

-- ── Decrypt helper for instructor accounts ────────────────────────────────────
-- Mirrors decrypt_account_password but reads the instructor accounts table.
create or replace function public.decrypt_instructor_account_password(account uuid) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v bytea;
begin
  select password_encrypted into v from public.turnitin_instructor_accounts where id = account;
  if v is null then return null; end if;
  return pgp_sym_decrypt(v, public._turnitin_key());
end $$;
revoke all on function public.decrypt_instructor_account_password(uuid) from public, anon, authenticated;
grant execute on function public.decrypt_instructor_account_password(uuid) to service_role;

-- ── Extend jobs (additive, nullable/defaulted) ────────────────────────────────
alter table public.jobs
  add column if not exists pipeline text not null default 'student',
  add column if not exists instructor_assignment_id uuid references public.turnitin_instructor_assignments(id),
  add column if not exists ai_report_status text;

-- ── Extend reports with a discriminator (similarity | ai) ──────────────────────
alter table public.reports
  add column if not exists kind text not null default 'similarity';
-- One job produces at most one report per kind.
create unique index if not exists reports_job_kind_uniq on public.reports(job_id, kind);

-- ── add_instructor_account: admin-only, encrypts server-side ───────────────────
create or replace function public.add_instructor_account(
  p_label text, p_email text, p_password text, p_login_url text, p_notes text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into public.turnitin_instructor_accounts(label, email, password_encrypted, login_url, notes)
  values (p_label, p_email, public.encrypt_account_password(p_password),
          coalesce(p_login_url,'https://www.turnitin.com/login_page.asp?lang=en_us'), p_notes)
  returning id into new_id;
  return new_id;
end $$;
revoke execute on function public.add_instructor_account(text,text,text,text,text) from public, anon;
grant execute on function public.add_instructor_account(text,text,text,text,text) to authenticated;

-- ── claim_next_instructor_job: independent of claim_next_job ───────────────────
-- Only picks pipeline='instructor' jobs; walks classes → assignments to find a
-- free assignment (live-lock rule: blocked only while a usage row is still open).
create or replace function public.claim_next_instructor_job(p_worker_id text)
returns public.jobs
language plpgsql security definer set search_path = public
as $$
declare
  v_assignment_id uuid;
  v_job           public.jobs;
begin
  -- ── Priority 1: resume a job already submitted to Turnitin ──────────────────
  update public.jobs j
  set status         = 'processing',
      worker_id      = p_worker_id,
      started_at     = now(),
      last_polled_at = now(),
      updated_at     = now()
  where j.id = (
    select id from public.jobs
    where  pipeline                = 'instructor'
      and  status                  = 'queued'
      and  turnitin_submission_id  is not null
      and  instructor_assignment_id is not null
      and  (queued_at is null or queued_at <= now())
    order by created_at
    limit 1
    for update skip locked
  )
  returning * into v_job;

  if v_job.id is not null then
    return v_job;
  end if;

  -- ── Priority 2: fresh job — pick a free assignment ──────────────────────────
  select a.id into v_assignment_id
  from   public.turnitin_instructor_assignments a
  join   public.turnitin_instructor_classes     c   on c.id = a.class_id
  join   public.turnitin_instructor_accounts    acc on acc.id = c.account_id
  where  a.is_active and c.is_active and acc.is_active
    and  not exists (
           select 1 from public.turnitin_instructor_slot_usage u
           where  u.assignment_id = a.id
             and  u.freed_at is null    -- blocked only while actively in use
         )
  order by (
    select coalesce(max(u2.freed_at), '1970-01-01'::timestamptz)
    from   public.turnitin_instructor_slot_usage u2
    where  u2.assignment_id = a.id
  ) asc   -- prefer assignments freed longest ago
  limit 1
  for update skip locked;

  if v_assignment_id is null then return null; end if;

  update public.jobs j
  set status                   = 'processing',
      instructor_assignment_id = v_assignment_id,
      worker_id                = p_worker_id,
      started_at               = now(),
      last_polled_at           = now(),
      attempts                 = j.attempts + 1,
      updated_at               = now()
  where j.id = (
    select id from public.jobs
    where  pipeline               = 'instructor'
      and  status                 = 'queued'
      and  turnitin_submission_id is null
      and  (queued_at is null or queued_at <= now())
    order by created_at
    limit 1
    for update skip locked
  )
  returning * into v_job;

  if v_job.id is null then return null; end if;

  insert into public.turnitin_instructor_slot_usage(assignment_id, job_id)
  values (v_assignment_id, v_job.id);
  return v_job;
end $$;
revoke all on function public.claim_next_instructor_job(text) from public, anon, authenticated;
grant execute on function public.claim_next_instructor_job(text) to service_role;

-- ── reassign_instructor_job_assignment: swap to the next free assignment ───────
-- Called when Turnitin denies a resubmission on the current assignment.
create or replace function public.reassign_instructor_job_assignment(
  p_job_id                 uuid,
  p_exclude_assignment_ids uuid[]
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_new_assignment_id uuid;
begin
  update public.turnitin_instructor_slot_usage
  set freed_at = now()
  where job_id = p_job_id and freed_at is null;

  select a.id into v_new_assignment_id
  from   public.turnitin_instructor_assignments a
  join   public.turnitin_instructor_classes     c   on c.id = a.class_id
  join   public.turnitin_instructor_accounts    acc on acc.id = c.account_id
  where  a.is_active and c.is_active and acc.is_active
    and  not (a.id = any(p_exclude_assignment_ids))
    and  not exists (
           select 1 from public.turnitin_instructor_slot_usage u
           where  u.assignment_id = a.id
             and  u.freed_at is null
         )
  order by (
    select coalesce(max(u2.freed_at), '1970-01-01'::timestamptz)
    from   public.turnitin_instructor_slot_usage u2
    where  u2.assignment_id = a.id
  ) asc
  limit 1
  for update skip locked;

  if v_new_assignment_id is null then return null; end if;

  update public.jobs
  set instructor_assignment_id = v_new_assignment_id, updated_at = now()
  where id = p_job_id;

  insert into public.turnitin_instructor_slot_usage(assignment_id, job_id)
  values (v_new_assignment_id, p_job_id);

  return v_new_assignment_id;
end $$;
revoke all on function public.reassign_instructor_job_assignment(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.reassign_instructor_job_assignment(uuid, uuid[]) to service_role;

-- ── Patch claim_next_job: never grab an instructor job ─────────────────────────
-- Identical to the v5 live-lock version, with `AND pipeline = 'student'` added to
-- both job-selection subqueries. Slot logic is unchanged.
create or replace function public.claim_next_job(p_worker_id text)
returns public.jobs
language plpgsql security definer set search_path = public
as $$
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

  -- Priority 2: fresh job — pick a free slot
  select s.id into v_slot_id
  from   public.turnitin_slots   s
  join   public.turnitin_accounts a on a.id = s.account_id
  where  s.is_active and a.is_active
    and  not exists (
           select 1 from public.turnitin_slot_usage u
           where  u.slot_id   = s.id
             and  u.freed_at is null
         )
  order by (
    select coalesce(max(u2.freed_at), '1970-01-01'::timestamptz)
    from   public.turnitin_slot_usage u2
    where  u2.slot_id = s.id
  ) asc
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
end $$;
revoke all on function public.claim_next_job(text) from public, anon, authenticated;
grant  execute on function public.claim_next_job(text) to service_role;

-- ── Extend requeue_stuck_jobs to also free instructor usage rows ───────────────
create or replace function public.requeue_stuck_jobs(p_max_age_minutes int default 45)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  with stuck as (
    update public.jobs
    set status = 'queued', worker_id = null, slot_id = null,
        error = coalesce(error,'') || ' [watchdog requeued]', updated_at = now()
    where status = 'processing'
      and last_polled_at < now() - make_interval(mins => p_max_age_minutes)
    returning id
  )
  select count(*) into n from stuck;

  -- Free student usage rows for requeued jobs that never submitted.
  update public.turnitin_slot_usage
  set freed_at = now()
  where job_id in (select id from public.jobs where status = 'queued' and worker_id is null)
    and freed_at is null;

  -- Free instructor usage rows for requeued jobs that never submitted.
  update public.turnitin_instructor_slot_usage
  set freed_at = now()
  where job_id in (
          select id from public.jobs
          where status = 'queued' and worker_id is null and turnitin_submission_id is null
        )
    and freed_at is null;

  return n;
end $$;
revoke all on function public.requeue_stuck_jobs(int) from public, anon, authenticated;
grant execute on function public.requeue_stuck_jobs(int) to service_role;
