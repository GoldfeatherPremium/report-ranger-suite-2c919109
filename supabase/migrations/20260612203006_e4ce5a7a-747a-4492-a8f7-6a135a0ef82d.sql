create or replace function public.list_job_slot_labels(p_job_ids uuid[])
returns table(job_id uuid, slot_label text)
language sql
stable
security definer
set search_path = public
as $$
  select
    j.id,
    case
      when j.pipeline = 'student' and ts.id is not null
        then sa.label || ' / ' || ts.label
      when j.pipeline = 'instructor' and iasg.id is not null
        then ia.label || ' / ' || ic.label || ' / ' || iasg.label
      else null
    end as slot_label
  from public.jobs j
  left join public.turnitin_slots ts                   on ts.id  = j.slot_id
  left join public.turnitin_accounts sa                on sa.id  = ts.account_id
  left join public.turnitin_instructor_assignments iasg on iasg.id = j.instructor_assignment_id
  left join public.turnitin_instructor_classes ic      on ic.id  = iasg.class_id
  left join public.turnitin_instructor_accounts ia     on ia.id  = ic.account_id
  where j.id = any(p_job_ids)
    and (j.user_id = auth.uid() or public.is_admin());
$$;

revoke all on function public.list_job_slot_labels(uuid[]) from public;
grant execute on function public.list_job_slot_labels(uuid[]) to authenticated;
grant execute on function public.list_job_slot_labels(uuid[]) to service_role;