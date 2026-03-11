-- Client-specific checklist builder and assignment model (shared DB for FSAIAPP + FAAIAPPreporting)
-- Transitional rollout: legacy user_id-based inspections remain valid.

create extension if not exists pgcrypto;

-- Core client entities
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique,
  active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_locations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, name)
);

create table if not exists public.client_user_roles (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'auditor', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, user_id)
);

-- Checklist builder entities (per client)
create table if not exists public.client_checklists (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  name text not null,
  active_version_id uuid,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_checklist_versions (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.client_checklists(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  version_no integer not null check (version_no > 0),
  status text not null check (status in ('draft', 'published', 'archived')),
  title text not null,
  published_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (checklist_id, version_no)
);

create table if not exists public.client_checklist_items (
  id uuid primary key default gen_random_uuid(),
  checklist_version_id uuid not null references public.client_checklist_versions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  item_type text not null check (item_type in ('section', 'question')),
  parent_item_id uuid references public.client_checklist_items(id) on delete set null,
  sort_order integer not null default 0,
  section_code text,
  section_title text,
  question_code text,
  question_text text,
  answer_type text check (answer_type in ('yes_no', 'score', 'text', 'single_select')),
  options_json jsonb not null default '[]'::jsonb,
  required boolean not null default false,
  scoring_config jsonb not null default '{}'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Assignment entities
create table if not exists public.inspection_assignments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  location_id uuid not null references public.client_locations(id) on delete restrict,
  assignee_user_id uuid not null references public.profiles(id) on delete restrict,
  checklist_version_id uuid not null references public.client_checklist_versions(id) on delete restrict,
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'overdue', 'cancelled')),
  inspection_id uuid unique references public.inspections(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  started_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Inspection linkage columns for new flow (legacy rows remain valid)
alter table public.inspections
  add column if not exists client_id uuid,
  add column if not exists location_id uuid,
  add column if not exists assignment_id uuid,
  add column if not exists checklist_version_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_locations_id_client_id_key'
  ) THEN
    ALTER TABLE public.client_locations
      ADD CONSTRAINT client_locations_id_client_id_key
      UNIQUE (id, client_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_checklist_versions_id_client_id_key'
  ) THEN
    ALTER TABLE public.client_checklist_versions
      ADD CONSTRAINT client_checklist_versions_id_client_id_key
      UNIQUE (id, client_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspection_assignments_id_client_id_key'
  ) THEN
    ALTER TABLE public.inspection_assignments
      ADD CONSTRAINT inspection_assignments_id_client_id_key
      UNIQUE (id, client_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspection_assignments_location_client_fkey'
  ) THEN
    ALTER TABLE public.inspection_assignments
      ADD CONSTRAINT inspection_assignments_location_client_fkey
      FOREIGN KEY (location_id, client_id) REFERENCES public.client_locations(id, client_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspection_assignments_checklist_client_fkey'
  ) THEN
    ALTER TABLE public.inspection_assignments
      ADD CONSTRAINT inspection_assignments_checklist_client_fkey
      FOREIGN KEY (checklist_version_id, client_id) REFERENCES public.client_checklist_versions(id, client_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_client_id_fkey'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_location_id_fkey'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES public.client_locations(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_assignment_id_fkey'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_assignment_id_fkey
      FOREIGN KEY (assignment_id) REFERENCES public.inspection_assignments(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_checklist_version_id_fkey'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_checklist_version_id_fkey
      FOREIGN KEY (checklist_version_id) REFERENCES public.client_checklist_versions(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_location_client_fkey'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_location_client_fkey
      FOREIGN KEY (location_id, client_id) REFERENCES public.client_locations(id, client_id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_checklist_client_fkey'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_checklist_client_fkey
      FOREIGN KEY (checklist_version_id, client_id) REFERENCES public.client_checklist_versions(id, client_id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_assignment_client_fkey'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_assignment_client_fkey
      FOREIGN KEY (assignment_id, client_id) REFERENCES public.inspection_assignments(id, client_id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_checklists_active_version_id_fkey'
  ) THEN
    ALTER TABLE public.client_checklists
      ADD CONSTRAINT client_checklists_active_version_id_fkey
      FOREIGN KEY (active_version_id) REFERENCES public.client_checklist_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspections_assignment_requires_client_link_check'
  ) THEN
    ALTER TABLE public.inspections
      ADD CONSTRAINT inspections_assignment_requires_client_link_check
      CHECK (
        assignment_id is null
        or (client_id is not null and location_id is not null and checklist_version_id is not null)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspection_assignments_completed_requires_inspection_check'
  ) THEN
    ALTER TABLE public.inspection_assignments
      ADD CONSTRAINT inspection_assignments_completed_requires_inspection_check
      CHECK (
        (status <> 'completed')
        or (inspection_id is not null and completed_at is not null)
      );
  END IF;
END $$;

create index if not exists clients_active_idx
  on public.clients(active, name);
create index if not exists client_locations_client_active_idx
  on public.client_locations(client_id, active, name);
create index if not exists client_user_roles_client_user_idx
  on public.client_user_roles(client_id, user_id);
create index if not exists client_user_roles_user_idx
  on public.client_user_roles(user_id, role);
create index if not exists client_checklist_versions_lookup_idx
  on public.client_checklist_versions(client_id, status, version_no desc);
create index if not exists client_checklist_items_version_sort_idx
  on public.client_checklist_items(checklist_version_id, sort_order);
create index if not exists inspection_assignments_assignee_status_due_idx
  on public.inspection_assignments(assignee_user_id, status, due_at);
create index if not exists inspection_assignments_client_status_due_idx
  on public.inspection_assignments(client_id, status, due_at);
create index if not exists inspections_client_created_idx
  on public.inspections(client_id, created_at desc);
create unique index if not exists inspections_assignment_id_unique_idx
  on public.inspections(assignment_id)
  where assignment_id is not null;

-- Shared updated_at trigger
create or replace function public.set_row_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.validate_inspection_assignment()
returns trigger
language plpgsql
as $$
declare
  location_client_id uuid;
  location_active boolean;
  checklist_client_id uuid;
  checklist_status text;
  assignee_role text;
begin
  select client_id, active
  into location_client_id, location_active
  from public.client_locations
  where id = new.location_id;

  if not found then
    raise exception 'Assignment location does not exist.';
  end if;

  if location_client_id <> new.client_id then
    raise exception 'Assignment location does not belong to client.';
  end if;

  if not location_active then
    raise exception 'Disabled location cannot receive assignments.';
  end if;

  select client_id, status
  into checklist_client_id, checklist_status
  from public.client_checklist_versions
  where id = new.checklist_version_id;

  if not found then
    raise exception 'Checklist version does not exist.';
  end if;

  if checklist_client_id <> new.client_id then
    raise exception 'Checklist version does not belong to client.';
  end if;

  if checklist_status <> 'published' then
    raise exception 'Assignments require a published checklist version.';
  end if;

  select role
  into assignee_role
  from public.client_user_roles
  where client_id = new.client_id
    and user_id = new.assignee_user_id
  limit 1;

  if assignee_role is null then
    raise exception 'Assignee must be a member of the client.';
  end if;

  if assignee_role = 'viewer' then
    raise exception 'Viewer role cannot be assigned inspections.';
  end if;

  if new.status = 'completed' and (new.inspection_id is null or new.completed_at is null) then
    raise exception 'Completed assignment requires inspection_id and completed_at.';
  end if;

  if new.status <> 'completed' and new.completed_at is not null then
    raise exception 'Only completed assignments may set completed_at.';
  end if;

  if new.status = 'pending' and new.started_at is not null then
    raise exception 'Pending assignments cannot set started_at.';
  end if;

  if new.status = 'in_progress' and new.started_at is null then
    new.started_at = now();
  end if;

  return new;
end;
$$;

create or replace function public.validate_inspection_assignment_link()
returns trigger
language plpgsql
as $$
declare
  assignment_client_id uuid;
  assignment_location_id uuid;
  assignment_checklist_version_id uuid;
  assignment_assignee_user_id uuid;
  assignment_status text;
begin
  if new.assignment_id is null then
    return new;
  end if;

  select client_id, location_id, checklist_version_id, assignee_user_id, status
  into assignment_client_id, assignment_location_id, assignment_checklist_version_id, assignment_assignee_user_id, assignment_status
  from public.inspection_assignments
  where id = new.assignment_id;

  if not found then
    raise exception 'Assignment does not exist.';
  end if;

  if assignment_status = 'cancelled' then
    raise exception 'Cancelled assignment cannot be started.';
  end if;

  if assignment_status = 'completed' then
    raise exception 'Completed assignment cannot be started again.';
  end if;

  if assignment_client_id <> new.client_id then
    raise exception 'Inspection client_id does not match assignment.';
  end if;

  if assignment_location_id <> new.location_id then
    raise exception 'Inspection location_id does not match assignment.';
  end if;

  if assignment_checklist_version_id <> new.checklist_version_id then
    raise exception 'Inspection checklist_version_id does not match assignment.';
  end if;

  if assignment_assignee_user_id <> new.user_id then
    raise exception 'Only assignment assignee can create linked inspection.';
  end if;

  return new;
end;
$$;

create or replace function public.refresh_overdue_assignments(p_client_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.inspection_assignments
  set status = 'overdue',
      updated_at = now()
  where status in ('pending', 'in_progress')
    and due_at < now()
    and (p_client_id is null or client_id = p_client_id);

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

drop trigger if exists trg_clients_updated_at on public.clients;
create trigger trg_clients_updated_at
before update on public.clients
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_client_locations_updated_at on public.client_locations;
create trigger trg_client_locations_updated_at
before update on public.client_locations
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_client_user_roles_updated_at on public.client_user_roles;
create trigger trg_client_user_roles_updated_at
before update on public.client_user_roles
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_client_checklists_updated_at on public.client_checklists;
create trigger trg_client_checklists_updated_at
before update on public.client_checklists
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_client_checklist_versions_updated_at on public.client_checklist_versions;
create trigger trg_client_checklist_versions_updated_at
before update on public.client_checklist_versions
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_client_checklist_items_updated_at on public.client_checklist_items;
create trigger trg_client_checklist_items_updated_at
before update on public.client_checklist_items
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_inspection_assignments_updated_at on public.inspection_assignments;
create trigger trg_inspection_assignments_updated_at
before update on public.inspection_assignments
for each row execute function public.set_row_updated_at();

drop trigger if exists trg_inspection_assignments_validate on public.inspection_assignments;
create trigger trg_inspection_assignments_validate
before insert or update on public.inspection_assignments
for each row execute function public.validate_inspection_assignment();

drop trigger if exists trg_inspections_validate_assignment_link on public.inspections;
create trigger trg_inspections_validate_assignment_link
before insert or update on public.inspections
for each row execute function public.validate_inspection_assignment_link();

-- Role helper functions for RLS
create or replace function public.current_client_role(p_client_id uuid)
returns text
language sql
stable
as $$
  select cur.role
  from public.client_user_roles cur
  where cur.client_id = p_client_id
    and cur.user_id = auth.uid()
  limit 1
$$;

create or replace function public.is_client_member(p_client_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.client_user_roles cur
    where cur.client_id = p_client_id
      and cur.user_id = auth.uid()
  )
$$;

create or replace function public.is_client_admin(p_client_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.client_user_roles cur
    where cur.client_id = p_client_id
      and cur.user_id = auth.uid()
      and cur.role in ('owner', 'manager')
  )
$$;

alter table public.clients enable row level security;
alter table public.client_locations enable row level security;
alter table public.client_user_roles enable row level security;
alter table public.client_checklists enable row level security;
alter table public.client_checklist_versions enable row level security;
alter table public.client_checklist_items enable row level security;
alter table public.inspection_assignments enable row level security;

-- Clients policies
DROP POLICY IF EXISTS "clients_select_member" ON public.clients;
create policy "clients_select_member"
on public.clients
for select
to authenticated
using (
  public.is_client_member(id)
  or auth.uid() = created_by
);

DROP POLICY IF EXISTS "clients_insert_creator" ON public.clients;
create policy "clients_insert_creator"
on public.clients
for insert
to authenticated
with check (auth.uid() = created_by);

DROP POLICY IF EXISTS "clients_update_admin" ON public.clients;
create policy "clients_update_admin"
on public.clients
for update
to authenticated
using (public.is_client_admin(id))
with check (public.is_client_admin(id));

DROP POLICY IF EXISTS "clients_delete_admin" ON public.clients;
create policy "clients_delete_admin"
on public.clients
for delete
to authenticated
using (public.is_client_admin(id));

-- Client locations policies
DROP POLICY IF EXISTS "client_locations_select_member" ON public.client_locations;
create policy "client_locations_select_member"
on public.client_locations
for select
to authenticated
using (public.is_client_member(client_id));

DROP POLICY IF EXISTS "client_locations_insert_admin" ON public.client_locations;
create policy "client_locations_insert_admin"
on public.client_locations
for insert
to authenticated
with check (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_locations_update_admin" ON public.client_locations;
create policy "client_locations_update_admin"
on public.client_locations
for update
to authenticated
using (public.is_client_admin(client_id))
with check (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_locations_delete_admin" ON public.client_locations;
create policy "client_locations_delete_admin"
on public.client_locations
for delete
to authenticated
using (public.is_client_admin(client_id));

-- Client role policies
DROP POLICY IF EXISTS "client_user_roles_select_member" ON public.client_user_roles;
create policy "client_user_roles_select_member"
on public.client_user_roles
for select
to authenticated
using (public.is_client_member(client_id));

DROP POLICY IF EXISTS "client_user_roles_insert_admin_or_bootstrap" ON public.client_user_roles;
create policy "client_user_roles_insert_admin_or_bootstrap"
on public.client_user_roles
for insert
to authenticated
with check (
  public.is_client_admin(client_id)
  or (
    auth.uid() = user_id
    and role = 'owner'
    and not exists (
      select 1 from public.client_user_roles cur where cur.client_id = client_id
    )
  )
);

DROP POLICY IF EXISTS "client_user_roles_update_admin" ON public.client_user_roles;
create policy "client_user_roles_update_admin"
on public.client_user_roles
for update
to authenticated
using (public.is_client_admin(client_id))
with check (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_user_roles_delete_admin" ON public.client_user_roles;
create policy "client_user_roles_delete_admin"
on public.client_user_roles
for delete
to authenticated
using (public.is_client_admin(client_id));

-- Checklist policies
DROP POLICY IF EXISTS "client_checklists_select_member" ON public.client_checklists;
create policy "client_checklists_select_member"
on public.client_checklists
for select
to authenticated
using (public.is_client_member(client_id));

DROP POLICY IF EXISTS "client_checklists_insert_admin" ON public.client_checklists;
create policy "client_checklists_insert_admin"
on public.client_checklists
for insert
to authenticated
with check (public.is_client_admin(client_id) and auth.uid() = created_by);

DROP POLICY IF EXISTS "client_checklists_update_admin" ON public.client_checklists;
create policy "client_checklists_update_admin"
on public.client_checklists
for update
to authenticated
using (public.is_client_admin(client_id))
with check (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_checklists_delete_admin" ON public.client_checklists;
create policy "client_checklists_delete_admin"
on public.client_checklists
for delete
to authenticated
using (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_checklist_versions_select_member" ON public.client_checklist_versions;
create policy "client_checklist_versions_select_member"
on public.client_checklist_versions
for select
to authenticated
using (public.is_client_member(client_id));

DROP POLICY IF EXISTS "client_checklist_versions_insert_admin" ON public.client_checklist_versions;
create policy "client_checklist_versions_insert_admin"
on public.client_checklist_versions
for insert
to authenticated
with check (public.is_client_admin(client_id) and auth.uid() = created_by);

DROP POLICY IF EXISTS "client_checklist_versions_update_admin" ON public.client_checklist_versions;
create policy "client_checklist_versions_update_admin"
on public.client_checklist_versions
for update
to authenticated
using (public.is_client_admin(client_id))
with check (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_checklist_versions_delete_admin" ON public.client_checklist_versions;
create policy "client_checklist_versions_delete_admin"
on public.client_checklist_versions
for delete
to authenticated
using (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_checklist_items_select_member" ON public.client_checklist_items;
create policy "client_checklist_items_select_member"
on public.client_checklist_items
for select
to authenticated
using (public.is_client_member(client_id));

DROP POLICY IF EXISTS "client_checklist_items_insert_admin" ON public.client_checklist_items;
create policy "client_checklist_items_insert_admin"
on public.client_checklist_items
for insert
to authenticated
with check (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_checklist_items_update_admin" ON public.client_checklist_items;
create policy "client_checklist_items_update_admin"
on public.client_checklist_items
for update
to authenticated
using (public.is_client_admin(client_id))
with check (public.is_client_admin(client_id));

DROP POLICY IF EXISTS "client_checklist_items_delete_admin" ON public.client_checklist_items;
create policy "client_checklist_items_delete_admin"
on public.client_checklist_items
for delete
to authenticated
using (public.is_client_admin(client_id));

-- Assignment policies
DROP POLICY IF EXISTS "inspection_assignments_select_visible" ON public.inspection_assignments;
create policy "inspection_assignments_select_visible"
on public.inspection_assignments
for select
to authenticated
using (
  assignee_user_id = auth.uid()
  or public.is_client_member(client_id)
);

DROP POLICY IF EXISTS "inspection_assignments_insert_admin" ON public.inspection_assignments;
create policy "inspection_assignments_insert_admin"
on public.inspection_assignments
for insert
to authenticated
with check (
  public.is_client_admin(client_id)
  and auth.uid() = created_by
);

DROP POLICY IF EXISTS "inspection_assignments_update_assignee_or_admin" ON public.inspection_assignments;
create policy "inspection_assignments_update_assignee_or_admin"
on public.inspection_assignments
for update
to authenticated
using (
  assignee_user_id = auth.uid()
  or public.is_client_admin(client_id)
)
with check (
  assignee_user_id = auth.uid()
  or public.is_client_admin(client_id)
);

DROP POLICY IF EXISTS "inspection_assignments_delete_admin" ON public.inspection_assignments;
create policy "inspection_assignments_delete_admin"
on public.inspection_assignments
for delete
to authenticated
using (public.is_client_admin(client_id));

-- Additional inspections policies for client-scoped reads and inserts
DROP POLICY IF EXISTS "inspections_select_client_member" ON public.inspections;
create policy "inspections_select_client_member"
on public.inspections
for select
to authenticated
using (
  client_id is not null
  and public.is_client_member(client_id)
);

DROP POLICY IF EXISTS "inspections_insert_with_client_member" ON public.inspections;
create policy "inspections_insert_with_client_member"
on public.inspections
for insert
to authenticated
with check (
  auth.uid() = user_id
  and (
    client_id is null
    or public.is_client_member(client_id)
  )
);

DROP POLICY IF EXISTS "inspections_update_client_admin" ON public.inspections;
create policy "inspections_update_client_admin"
on public.inspections
for update
to authenticated
using (
  client_id is not null
  and public.is_client_admin(client_id)
)
with check (
  client_id is not null
  and public.is_client_admin(client_id)
);

DROP POLICY IF EXISTS "inspection_checklist_sections_select_client_member" ON public.inspection_checklist_sections;
create policy "inspection_checklist_sections_select_client_member"
on public.inspection_checklist_sections
for select
to authenticated
using (
  exists (
    select 1
    from public.inspections i
    where i.id = inspection_id
      and i.client_id is not null
      and public.is_client_member(i.client_id)
  )
);

DROP POLICY IF EXISTS "inspection_checklist_images_select_client_member" ON public.inspection_checklist_images;
create policy "inspection_checklist_images_select_client_member"
on public.inspection_checklist_images
for select
to authenticated
using (
  exists (
    select 1
    from public.inspection_checklist_sections ics
    join public.inspections i on i.id = ics.inspection_id
    where ics.id = inspection_checklist_section_id
      and i.client_id is not null
      and public.is_client_member(i.client_id)
  )
);

DROP POLICY IF EXISTS "section_assessments_select_client_member" ON public.section_assessments;
create policy "section_assessments_select_client_member"
on public.section_assessments
for select
to authenticated
using (
  exists (
    select 1
    from public.inspections i
    where i.id = inspection_id
      and i.client_id is not null
      and public.is_client_member(i.client_id)
  )
);

DROP POLICY IF EXISTS "inspection_images_select_client_member" ON public.inspection_images;
create policy "inspection_images_select_client_member"
on public.inspection_images
for select
to authenticated
using (
  exists (
    select 1
    from public.inspections i
    where i.id = inspection_id
      and i.client_id is not null
      and public.is_client_member(i.client_id)
  )
);

DROP POLICY IF EXISTS "findings_select_client_member" ON public.findings;
create policy "findings_select_client_member"
on public.findings
for select
to authenticated
using (
  exists (
    select 1
    from public.inspections i
    where i.id = inspection_id
      and i.client_id is not null
      and public.is_client_member(i.client_id)
  )
);

DROP POLICY IF EXISTS "ai_runs_select_client_member" ON public.ai_runs;
create policy "ai_runs_select_client_member"
on public.ai_runs
for select
to authenticated
using (
  exists (
    select 1
    from public.inspections i
    where i.id = inspection_id
      and i.client_id is not null
      and public.is_client_member(i.client_id)
  )
);
