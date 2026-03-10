create extension if not exists pgcrypto;

-- Enums
DO $$ BEGIN
  create type public.report_kind as enum ('summary', 'full');
EXCEPTION
  when duplicate_object then null;
END $$;

DO $$ BEGIN
  create type public.report_job_status as enum ('pending', 'running', 'retry', 'completed', 'failed', 'dead_letter');
EXCEPTION
  when duplicate_object then null;
END $$;

DO $$ BEGIN
  create type public.report_version_status as enum ('queued', 'generating', 'completed', 'failed');
EXCEPTION
  when duplicate_object then null;
END $$;

-- Versioned immutable report artifacts
create table if not exists public.inspection_report_versions (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections(id) on delete cascade,
  user_id uuid not null,
  report_kind public.report_kind not null,
  template_version text not null,
  data_hash text not null,
  version_no integer not null,
  status public.report_version_status not null default 'queued',
  storage_bucket text,
  storage_path text,
  page_count integer,
  asset_manifest_json jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (inspection_id, report_kind, template_version, data_hash),
  unique (inspection_id, report_kind, version_no)
);

create index if not exists inspection_report_versions_inspection_idx
  on public.inspection_report_versions(inspection_id, report_kind, created_at desc);
create index if not exists inspection_report_versions_status_idx
  on public.inspection_report_versions(status);

-- Latest pointers used by app APIs
create table if not exists public.inspection_report_latest (
  inspection_id uuid primary key references public.inspections(id) on delete cascade,
  user_id uuid not null,
  summary_version_id uuid references public.inspection_report_versions(id) on delete set null,
  full_version_id uuid references public.inspection_report_versions(id) on delete set null,
  last_error text,
  last_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inspection_report_latest_user_idx
  on public.inspection_report_latest(user_id, last_updated_at desc);

-- Staged assets (charts/thumbnails)
create table if not exists public.inspection_report_assets (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.inspection_report_versions(id) on delete cascade,
  inspection_id uuid not null references public.inspections(id) on delete cascade,
  user_id uuid not null,
  asset_type text not null,
  asset_key text not null,
  storage_bucket text not null,
  storage_path text not null,
  mime_type text,
  bytes integer,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (version_id, asset_type, asset_key)
);

create index if not exists inspection_report_assets_version_idx
  on public.inspection_report_assets(version_id, asset_type);

-- Queue jobs consumed by Cloud Run worker
create table if not exists public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections(id) on delete cascade,
  user_id uuid not null,
  report_kind public.report_kind not null,
  template_version text not null,
  target_version_id uuid references public.inspection_report_versions(id) on delete set null,
  status public.report_job_status not null default 'pending',
  priority integer not null default 100,
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_owner text,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  stage_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists report_jobs_claim_idx
  on public.report_jobs(status, priority, next_run_at);
create index if not exists report_jobs_inspection_idx
  on public.report_jobs(inspection_id, report_kind, created_at desc);

-- Generic updated_at trigger helper
create or replace function public.set_row_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_report_versions_updated_at on public.inspection_report_versions;
create trigger trg_report_versions_updated_at
before update on public.inspection_report_versions
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_report_latest_updated_at on public.inspection_report_latest;
create trigger trg_report_latest_updated_at
before update on public.inspection_report_latest
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_report_jobs_updated_at on public.report_jobs;
create trigger trg_report_jobs_updated_at
before update on public.report_jobs
for each row execute function public.set_row_updated_at();

-- Compatibility pointer extension
alter table public.inspection_reports
  add column if not exists summary_version_id uuid references public.inspection_report_versions(id) on delete set null,
  add column if not exists full_version_id uuid references public.inspection_report_versions(id) on delete set null,
  add column if not exists last_error text,
  add column if not exists last_updated_at timestamptz default now();

-- Claim jobs atomically from multiple workers
create or replace function public.claim_report_jobs(p_worker_id text, p_limit integer default 1)
returns setof public.report_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  return query
  with next_jobs as (
    select j.id
    from public.report_jobs j
    where j.status in ('pending', 'retry')
      and j.next_run_at <= v_now
      and j.attempt_count < j.max_attempts
    order by j.priority asc, j.next_run_at asc
    for update skip locked
    limit greatest(p_limit, 1)
  ), updated as (
    update public.report_jobs j
    set status = 'running',
        locked_at = v_now,
        lock_owner = p_worker_id,
        started_at = coalesce(j.started_at, v_now),
        updated_at = v_now
    from next_jobs n
    where j.id = n.id
    returning j.*
  )
  select * from updated;
end;
$$;

revoke all on function public.claim_report_jobs(text, integer) from public;
grant execute on function public.claim_report_jobs(text, integer) to service_role;

-- Recover stale running jobs
create or replace function public.reset_stale_report_jobs(p_stale_minutes integer default 15)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with updated as (
    update public.report_jobs
    set status = 'retry',
        next_run_at = now(),
        lock_owner = null,
        locked_at = null,
        last_error = coalesce(last_error, 'Recovered stale running job'),
        updated_at = now()
    where status = 'running'
      and locked_at is not null
      and locked_at < now() - make_interval(mins => p_stale_minutes)
    returning 1
  )
  select count(*) into v_count from updated;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.reset_stale_report_jobs(integer) from public;
grant execute on function public.reset_stale_report_jobs(integer) to service_role;

-- RLS
alter table public.inspection_report_versions enable row level security;
alter table public.inspection_report_latest enable row level security;
alter table public.inspection_report_assets enable row level security;
alter table public.report_jobs enable row level security;

drop policy if exists "inspection_report_versions_select_own" on public.inspection_report_versions;
create policy "inspection_report_versions_select_own"
on public.inspection_report_versions
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "inspection_report_latest_select_own" on public.inspection_report_latest;
create policy "inspection_report_latest_select_own"
on public.inspection_report_latest
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "inspection_report_assets_select_own" on public.inspection_report_assets;
create policy "inspection_report_assets_select_own"
on public.inspection_report_assets
for select
to authenticated
using (auth.uid() = user_id);

-- Buckets
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'inspection-report-assets',
  'inspection-report-assets',
  false,
  52428800,
  array['image/png', 'image/jpeg', 'application/json']
)
on conflict (id) do nothing;
