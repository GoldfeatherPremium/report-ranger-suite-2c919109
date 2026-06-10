create or replace function public.fail_stuck_jobs(p_max_age_minutes integer default 30)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare n int;
begin
  with stuck as (
    update public.jobs
    set status = 'failed',
        finished_at = now(),
        worker_id = null,
        error = coalesce(error,'') || ' [auto-failed: exceeded ' || p_max_age_minutes || ' min]',
        updated_at = now()
    where status = 'processing'
      and started_at is not null
      and started_at < now() - make_interval(mins => p_max_age_minutes)
    returning id
  )
  select count(*) into n from stuck;

  update public.turnitin_slot_usage
  set freed_at = now()
  where job_id in (select id from public.jobs where status = 'failed')
    and freed_at is null;

  update public.turnitin_instructor_slot_usage
  set freed_at = now()
  where job_id in (select id from public.jobs where status = 'failed')
    and freed_at is null;

  return n;
end $$;

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'fail-stuck-jobs-30min') then
    perform cron.unschedule('fail-stuck-jobs-30min');
  end if;
end $$;

select cron.schedule(
  'fail-stuck-jobs-30min',
  '* * * * *',
  $$ select public.fail_stuck_jobs(30); $$
);