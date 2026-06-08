-- Instructor worker "Teach & Replay" training store.
--
-- The new instructor worker learns Turnitin's UI interactively: it logs in,
-- screenshots each screen, records the clickable elements it detected, and the
-- operator tells it what to do next. Every confirmed action is saved so the
-- sequence can later be replayed automatically against real documents.
--
-- Everything here is additive. Nothing touches the student pipeline or the
-- existing instructor account/class/assignment tables — those still drive slot
-- selection. These tables only capture the *learned click-flow*.

-- ── Screenshot bucket (private) ───────────────────────────────────────────────
-- The worker (service_role) writes PNGs here; admins can read them. Each object
-- lives under sessions/<session_id>/<NNN>.png.
insert into storage.buckets (id, name, public)
values ('training', 'training', false)
on conflict (id) do nothing;

drop policy if exists training_admin_select on storage.objects;
create policy training_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'training' and public.is_admin());

-- ── Learned flows ─────────────────────────────────────────────────────────────
-- A flow is the ordered list of actions to drive one instructor account from
-- login to the two finished reports. account_id NULL == a global default flow.
create table public.turnitin_instructor_flows (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid references public.turnitin_instructor_accounts(id) on delete cascade,
  name        text not null,
  status      text not null default 'draft',        -- draft | active | archived
  steps       jsonb not null default '[]'::jsonb,    -- [{type, selector, frame, text, value, key, note}]
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_instructor_flows_account on public.turnitin_instructor_flows(account_id);
create index idx_instructor_flows_active  on public.turnitin_instructor_flows(account_id, status);
grant select, insert, update, delete on public.turnitin_instructor_flows to authenticated;
grant all on public.turnitin_instructor_flows to service_role;
alter table public.turnitin_instructor_flows enable row level security;
create policy turnitin_instructor_flows_admin_all on public.turnitin_instructor_flows for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create trigger trg_turnitin_instructor_flows_updated before update on public.turnitin_instructor_flows
  for each row execute function public.set_updated_at();

-- ── Training sessions ─────────────────────────────────────────────────────────
-- One row per interactive teaching run.
create table public.turnitin_training_sessions (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid references public.turnitin_instructor_accounts(id) on delete set null,
  worker_id   text not null,
  status      text not null default 'active',        -- active | finished | aborted
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_training_sessions_account on public.turnitin_training_sessions(account_id);
grant select, insert, update, delete on public.turnitin_training_sessions to authenticated;
grant all on public.turnitin_training_sessions to service_role;
alter table public.turnitin_training_sessions enable row level security;
create policy turnitin_training_sessions_admin_all on public.turnitin_training_sessions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create trigger trg_turnitin_training_sessions_updated before update on public.turnitin_training_sessions
  for each row execute function public.set_updated_at();

-- ── Training steps ────────────────────────────────────────────────────────────
-- One row per captured screen + the action the operator chose on it.
create table public.turnitin_training_steps (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.turnitin_training_sessions(id) on delete cascade,
  idx             integer not null,                  -- order within the session
  page_url        text,
  page_title      text,
  screenshot_path text,                              -- path in the 'training' bucket
  elements        jsonb not null default '[]'::jsonb, -- detected clickable elements (no handles)
  action          jsonb,                             -- the action taken on this screen
  status          text not null default 'captured',  -- captured | executed | failed
  result          text,
  created_at      timestamptz not null default now()
);
create index idx_training_steps_session on public.turnitin_training_steps(session_id, idx);
grant select, insert, update, delete on public.turnitin_training_steps to authenticated;
grant all on public.turnitin_training_steps to service_role;
alter table public.turnitin_training_steps enable row level security;
create policy turnitin_training_steps_admin_all on public.turnitin_training_steps for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
