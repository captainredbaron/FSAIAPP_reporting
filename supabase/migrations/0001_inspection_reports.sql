create table if not exists public.inspection_reports (
  inspection_id uuid primary key references public.inspections(id) on delete cascade,
  user_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'generating', 'completed', 'failed')),
  storage_bucket text not null default 'inspection-reports',
  storage_path text,
  error_message text,
  generated_at timestamptz,
  source_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inspection_reports_user_id_idx on public.inspection_reports(user_id);
create index if not exists inspection_reports_status_idx on public.inspection_reports(status);

create or replace function public.set_inspection_reports_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_inspection_reports_updated_at on public.inspection_reports;
create trigger trg_inspection_reports_updated_at
before update on public.inspection_reports
for each row
execute function public.set_inspection_reports_updated_at();

alter table public.inspection_reports enable row level security;

drop policy if exists "inspection_reports_select_own" on public.inspection_reports;
create policy "inspection_reports_select_own"
on public.inspection_reports
for select
to authenticated
using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'inspection-reports',
  'inspection-reports',
  false,
  52428800,
  array['application/pdf']
)
on conflict (id) do nothing;
