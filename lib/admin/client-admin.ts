import { supabaseAdmin } from "@/lib/supabase/admin";

export type ClientUserRole = "owner" | "manager" | "auditor" | "viewer";
export type AssignmentStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "overdue"
  | "cancelled";

const CLIENT_ADMIN_ROLES: ClientUserRole[] = ["owner", "manager"];

export interface AdminClientSummary {
  id: string;
  name: string;
  code: string | null;
  active: boolean;
  my_role: ClientUserRole;
}

export interface ClientLocationSummary {
  id: string;
  client_id: string;
  name: string;
  address: string | null;
  active: boolean;
  created_at: string;
}

export interface ClientRoleMemberSummary {
  id: string;
  client_id: string;
  user_id: string;
  role: ClientUserRole;
  email: string | null;
  full_name: string | null;
}

export interface ChecklistVersionSummary {
  id: string;
  client_id: string;
  checklist_id: string;
  version_no: number;
  status: "draft" | "published" | "archived";
  title: string;
  published_at: string | null;
  created_at: string;
  is_active: boolean;
}

export interface ChecklistSectionDraftItem {
  section_code: string;
  section_title: string;
  description?: string | null;
}

export interface ChecklistVersionSectionItem {
  id: string;
  checklist_version_id: string;
  sort_order: number;
  section_code: string;
  section_title: string;
  description: string | null;
}

export interface AssignmentSummary {
  id: string;
  client_id: string;
  location_id: string;
  assignee_user_id: string;
  checklist_version_id: string;
  due_at: string;
  status: AssignmentStatus;
  inspection_id: string | null;
  created_at: string;
  location_name: string;
  assignee_email: string;
  assignee_name: string | null;
  checklist_title: string;
  checklist_version_no: number;
}

export function normalizeClientCode(input: string) {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

  return normalized.length > 0 ? normalized : null;
}

export async function getClientRole(clientId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("client_user_roles")
    .select("role")
    .eq("client_id", clientId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data?.role as ClientUserRole | undefined) ?? null;
}

export async function assertClientAdmin(clientId: string, userId: string) {
  const role = await getClientRole(clientId, userId);
  if (!role || !CLIENT_ADMIN_ROLES.includes(role)) {
    throw new Error("You do not have admin permissions for this client.");
  }

  return role;
}

export async function listAdminClients(userId: string) {
  const { data: memberships, error: membershipsError } = await supabaseAdmin
    .from("client_user_roles")
    .select("client_id,role")
    .eq("user_id", userId)
    .in("role", CLIENT_ADMIN_ROLES);

  if (membershipsError) {
    throw new Error(membershipsError.message);
  }

  const membershipRows =
    (memberships as Array<{ client_id: string; role: ClientUserRole }> | null) ?? [];

  if (!membershipRows.length) {
    return [] as AdminClientSummary[];
  }

  const clientIds = [...new Set(membershipRows.map((row) => row.client_id))];
  const { data: clients, error: clientsError } = await supabaseAdmin
    .from("clients")
    .select("id,name,code,active")
    .in("id", clientIds)
    .order("name", { ascending: true });

  if (clientsError) {
    throw new Error(clientsError.message);
  }

  const roleByClientId = new Map(membershipRows.map((row) => [row.client_id, row.role]));

  return (
    (clients as Array<{ id: string; name: string; code: string | null; active: boolean }> | null) ??
    []
  )
    .map((client) => ({
      ...client,
      my_role: roleByClientId.get(client.id) ?? "manager"
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createClient(input: {
  userId: string;
  name: string;
  code?: string | null;
}) {
  const cleanedName = input.name.trim();
  if (!cleanedName) {
    throw new Error("Client name is required.");
  }

  const normalizedCode = input.code ? normalizeClientCode(input.code) : null;

  const { data: client, error: clientError } = await supabaseAdmin
    .from("clients")
    .insert({
      name: cleanedName,
      code: normalizedCode,
      active: true,
      created_by: input.userId
    })
    .select("id,name")
    .single();

  if (clientError || !client) {
    throw new Error(clientError?.message ?? "Failed to create client.");
  }

  const { error: ownerRoleError } = await supabaseAdmin.from("client_user_roles").insert({
    client_id: client.id,
    user_id: input.userId,
    role: "owner"
  });

  if (ownerRoleError) {
    await supabaseAdmin.from("clients").delete().eq("id", client.id);
    throw new Error(ownerRoleError.message);
  }

  const { data: checklist, error: checklistError } = await supabaseAdmin
    .from("client_checklists")
    .insert({
      client_id: client.id,
      name: `${client.name} Checklist`,
      created_by: input.userId
    })
    .select("id")
    .single();

  if (checklistError || !checklist) {
    throw new Error(checklistError?.message ?? "Failed to initialize checklist.");
  }

  const { error: initialDraftError } = await supabaseAdmin
    .from("client_checklist_versions")
    .insert({
      checklist_id: checklist.id,
      client_id: client.id,
      version_no: 1,
      status: "draft",
      title: "Initial Draft",
      created_by: input.userId
    });

  if (initialDraftError) {
    throw new Error(initialDraftError.message);
  }

  return client.id;
}

export async function listClientLocations(clientId: string, userId: string) {
  await assertClientAdmin(clientId, userId);

  const { data, error } = await supabaseAdmin
    .from("client_locations")
    .select("id,client_id,name,address,active,created_at")
    .eq("client_id", clientId)
    .order("name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as ClientLocationSummary[];
}

export async function saveClientLocation(input: {
  userId: string;
  clientId: string;
  locationId?: string | null;
  name: string;
  address?: string | null;
  active?: boolean;
}) {
  await assertClientAdmin(input.clientId, input.userId);

  const name = input.name.trim();
  if (!name) {
    throw new Error("Location name is required.");
  }

  const address = input.address?.trim() || null;
  const active = input.active ?? true;

  if (input.locationId) {
    const { error } = await supabaseAdmin
      .from("client_locations")
      .update({ name, address, active })
      .eq("id", input.locationId)
      .eq("client_id", input.clientId);

    if (error) {
      throw new Error(error.message);
    }

    return input.locationId;
  }

  const { data, error } = await supabaseAdmin
    .from("client_locations")
    .insert({
      client_id: input.clientId,
      name,
      address,
      active
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to save location.");
  }

  return data.id;
}

export async function listClientRoleMembers(clientId: string, userId: string) {
  await assertClientAdmin(clientId, userId);

  const { data: roleRows, error: roleError } = await supabaseAdmin
    .from("client_user_roles")
    .select("id,client_id,user_id,role")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });

  if (roleError) {
    throw new Error(roleError.message);
  }

  const roles =
    (roleRows as Array<{ id: string; client_id: string; user_id: string; role: ClientUserRole }> | null) ??
    [];

  if (!roles.length) {
    return [] as ClientRoleMemberSummary[];
  }

  const userIds = [...new Set(roles.map((row) => row.user_id))];
  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from("profiles")
    .select("id,email,full_name")
    .in("id", userIds);

  if (profilesError) {
    throw new Error(profilesError.message);
  }

  const profileById = new Map(
    (
      (profiles as Array<{ id: string; email: string | null; full_name: string | null }> | null) ??
      []
    ).map((profile) => [profile.id, profile])
  );

  return roles
    .map((roleRow) => {
      const profile = profileById.get(roleRow.user_id);
      return {
        ...roleRow,
        email: profile?.email ?? null,
        full_name: profile?.full_name ?? null
      };
    })
    .sort((a, b) => {
      const emailA = a.email?.toLowerCase() ?? "";
      const emailB = b.email?.toLowerCase() ?? "";
      return emailA.localeCompare(emailB);
    });
}

export async function setClientUserRoleByEmail(input: {
  userId: string;
  clientId: string;
  email: string;
  role: ClientUserRole;
}) {
  await assertClientAdmin(input.clientId, input.userId);

  const email = input.email.trim().toLowerCase();
  if (!email) {
    throw new Error("User email is required.");
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id,email")
    .ilike("email", email)
    .maybeSingle();

  if (profileError) {
    throw new Error(profileError.message);
  }

  if (!profile) {
    throw new Error("No user profile found for that email.");
  }

  const { error } = await supabaseAdmin.from("client_user_roles").upsert(
    {
      client_id: input.clientId,
      user_id: profile.id,
      role: input.role
    },
    {
      onConflict: "client_id,user_id"
    }
  );

  if (error) {
    throw new Error(error.message);
  }
}

async function ensureChecklistRoot(clientId: string, userId: string) {
  await assertClientAdmin(clientId, userId);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("client_checklists")
    .select("id,client_id,name,active_version_id")
    .eq("client_id", clientId)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (existing) {
    return existing as {
      id: string;
      client_id: string;
      name: string;
      active_version_id: string | null;
    };
  }

  const { data: created, error: createError } = await supabaseAdmin
    .from("client_checklists")
    .insert({
      client_id: clientId,
      name: "Client Checklist",
      created_by: userId
    })
    .select("id,client_id,name,active_version_id")
    .single();

  if (createError || !created) {
    throw new Error(createError?.message ?? "Failed to initialize client checklist.");
  }

  return created as {
    id: string;
    client_id: string;
    name: string;
    active_version_id: string | null;
  };
}

export async function listClientChecklistVersions(clientId: string, userId: string) {
  const checklist = await ensureChecklistRoot(clientId, userId);

  const { data, error } = await supabaseAdmin
    .from("client_checklist_versions")
    .select("id,client_id,checklist_id,version_no,status,title,published_at,created_at")
    .eq("client_id", clientId)
    .eq("checklist_id", checklist.id)
    .order("version_no", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const rows =
    (data as Array<{
      id: string;
      client_id: string;
      checklist_id: string;
      version_no: number;
      status: "draft" | "published" | "archived";
      title: string;
      published_at: string | null;
      created_at: string;
    }> | null) ?? [];

  return rows.map((row) => ({
    ...row,
    is_active: checklist.active_version_id === row.id
  }));
}

export async function getChecklistSectionsByVersion(input: {
  clientId: string;
  versionId: string;
  userId: string;
}) {
  await assertClientAdmin(input.clientId, input.userId);

  const { data: version, error: versionError } = await supabaseAdmin
    .from("client_checklist_versions")
    .select("id,client_id")
    .eq("id", input.versionId)
    .eq("client_id", input.clientId)
    .maybeSingle();

  if (versionError) {
    throw new Error(versionError.message);
  }

  if (!version) {
    return [] as ChecklistVersionSectionItem[];
  }

  const { data, error } = await supabaseAdmin
    .from("client_checklist_items")
    .select("id,checklist_version_id,sort_order,section_code,section_title,metadata_json")
    .eq("client_id", input.clientId)
    .eq("checklist_version_id", input.versionId)
    .eq("item_type", "section")
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const rows =
    (data as Array<{
      id: string;
      checklist_version_id: string;
      sort_order: number;
      section_code: string | null;
      section_title: string | null;
      metadata_json: Record<string, unknown>;
    }> | null) ?? [];

  return rows.map((row) => {
    const description =
      typeof row.metadata_json?.description === "string"
        ? (row.metadata_json.description as string)
        : null;

    return {
      id: row.id,
      checklist_version_id: row.checklist_version_id,
      sort_order: row.sort_order,
      section_code: row.section_code ?? "",
      section_title: row.section_title ?? "",
      description
    };
  });
}

export async function createChecklistDraft(input: {
  userId: string;
  clientId: string;
  title: string;
  sections: ChecklistSectionDraftItem[];
}) {
  const checklist = await ensureChecklistRoot(input.clientId, input.userId);

  const sections = input.sections
    .map((section) => ({
      section_code: section.section_code.trim().toUpperCase(),
      section_title: section.section_title.trim(),
      description: section.description?.trim() || null
    }))
    .filter((section) => section.section_code.length > 0 && section.section_title.length > 0);

  if (!sections.length) {
    throw new Error("At least one section is required for a draft checklist version.");
  }

  const seenCodes = new Set<string>();
  for (const section of sections) {
    if (seenCodes.has(section.section_code)) {
      throw new Error(`Duplicate section code: ${section.section_code}`);
    }
    seenCodes.add(section.section_code);
  }

  const { data: latestVersion } = await supabaseAdmin
    .from("client_checklist_versions")
    .select("version_no")
    .eq("checklist_id", checklist.id)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (latestVersion?.version_no ?? 0) + 1;

  const { data: version, error: versionError } = await supabaseAdmin
    .from("client_checklist_versions")
    .insert({
      checklist_id: checklist.id,
      client_id: input.clientId,
      version_no: nextVersion,
      status: "draft",
      title: input.title.trim() || `Draft v${nextVersion}`,
      created_by: input.userId
    })
    .select("id")
    .single();

  if (versionError || !version) {
    throw new Error(versionError?.message ?? "Unable to create checklist draft version.");
  }

  const { error: itemsError } = await supabaseAdmin.from("client_checklist_items").insert(
    sections.map((section, index) => ({
      checklist_version_id: version.id,
      client_id: input.clientId,
      item_type: "section",
      sort_order: index + 1,
      section_code: section.section_code,
      section_title: section.section_title,
      metadata_json: {
        description: section.description
      }
    }))
  );

  if (itemsError) {
    await supabaseAdmin.from("client_checklist_versions").delete().eq("id", version.id);
    throw new Error(itemsError.message);
  }

  return version.id;
}

export async function publishChecklistVersion(input: {
  userId: string;
  clientId: string;
  versionId: string;
}) {
  const checklist = await ensureChecklistRoot(input.clientId, input.userId);

  const { data: version, error: versionError } = await supabaseAdmin
    .from("client_checklist_versions")
    .select("id,status")
    .eq("id", input.versionId)
    .eq("client_id", input.clientId)
    .maybeSingle();

  if (versionError) {
    throw new Error(versionError.message);
  }

  if (!version) {
    throw new Error("Checklist version not found.");
  }

  const { count, error: countError } = await supabaseAdmin
    .from("client_checklist_items")
    .select("id", { count: "exact", head: true })
    .eq("checklist_version_id", input.versionId)
    .eq("item_type", "section");

  if (countError) {
    throw new Error(countError.message);
  }

  if (!count) {
    throw new Error("Cannot publish an empty checklist version.");
  }

  if (version.status !== "published") {
    const { error: publishError } = await supabaseAdmin
      .from("client_checklist_versions")
      .update({
        status: "published",
        published_at: new Date().toISOString()
      })
      .eq("id", input.versionId)
      .eq("client_id", input.clientId);

    if (publishError) {
      throw new Error(publishError.message);
    }
  }

  const { error: activateError } = await supabaseAdmin
    .from("client_checklists")
    .update({ active_version_id: input.versionId })
    .eq("id", checklist.id)
    .eq("client_id", input.clientId);

  if (activateError) {
    throw new Error(activateError.message);
  }
}

async function refreshOverdueAssignments(clientId: string) {
  const { error } = await supabaseAdmin.rpc("refresh_overdue_assignments", {
    p_client_id: clientId
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function listAssignments(input: {
  userId: string;
  clientId: string;
  status?: AssignmentStatus | "all";
}) {
  await assertClientAdmin(input.clientId, input.userId);
  await refreshOverdueAssignments(input.clientId);

  let query = supabaseAdmin
    .from("inspection_assignments")
    .select(
      "id,client_id,location_id,assignee_user_id,checklist_version_id,due_at,status,inspection_id,created_at"
    )
    .eq("client_id", input.clientId)
    .order("due_at", { ascending: true });

  if (input.status && input.status !== "all") {
    query = query.eq("status", input.status);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const rows =
    (data as Array<{
      id: string;
      client_id: string;
      location_id: string;
      assignee_user_id: string;
      checklist_version_id: string;
      due_at: string;
      status: AssignmentStatus;
      inspection_id: string | null;
      created_at: string;
    }> | null) ?? [];

  if (!rows.length) {
    return [] as AssignmentSummary[];
  }

  const locationIds = [...new Set(rows.map((row) => row.location_id))];
  const assigneeIds = [...new Set(rows.map((row) => row.assignee_user_id))];
  const checklistVersionIds = [...new Set(rows.map((row) => row.checklist_version_id))];

  const [locationsResult, profilesResult, versionsResult] = await Promise.all([
    supabaseAdmin.from("client_locations").select("id,name").in("id", locationIds),
    supabaseAdmin.from("profiles").select("id,email,full_name").in("id", assigneeIds),
    supabaseAdmin
      .from("client_checklist_versions")
      .select("id,title,version_no")
      .in("id", checklistVersionIds)
  ]);

  if (locationsResult.error) {
    throw new Error(locationsResult.error.message);
  }
  if (profilesResult.error) {
    throw new Error(profilesResult.error.message);
  }
  if (versionsResult.error) {
    throw new Error(versionsResult.error.message);
  }

  const locationById = new Map(
    ((locationsResult.data as Array<{ id: string; name: string }> | null) ?? []).map((row) => [
      row.id,
      row.name
    ])
  );

  const profileById = new Map(
    (
      (profilesResult.data as Array<{ id: string; email: string | null; full_name: string | null }> | null) ??
      []
    ).map((row) => [row.id, row])
  );

  const versionById = new Map(
    ((versionsResult.data as Array<{ id: string; title: string; version_no: number }> | null) ?? []).map((row) => [
      row.id,
      row
    ])
  );

  return rows.map((row) => {
    const profile = profileById.get(row.assignee_user_id);
    const checklist = versionById.get(row.checklist_version_id);

    return {
      ...row,
      location_name: locationById.get(row.location_id) ?? "Unknown location",
      assignee_email: profile?.email ?? "Unknown user",
      assignee_name: profile?.full_name ?? null,
      checklist_title: checklist?.title ?? "Checklist",
      checklist_version_no: checklist?.version_no ?? 0
    };
  });
}

export async function createAssignment(input: {
  userId: string;
  clientId: string;
  locationId: string;
  assigneeUserId: string;
  checklistVersionId: string;
  dueAt: string;
}) {
  await assertClientAdmin(input.clientId, input.userId);

  const dueAtIso = new Date(input.dueAt).toISOString();

  const { data, error } = await supabaseAdmin
    .from("inspection_assignments")
    .insert({
      client_id: input.clientId,
      location_id: input.locationId,
      assignee_user_id: input.assigneeUserId,
      checklist_version_id: input.checklistVersionId,
      due_at: dueAtIso,
      status: "pending",
      created_by: input.userId
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create assignment.");
  }

  return data.id;
}

export async function updateAssignment(input: {
  userId: string;
  clientId: string;
  assignmentId: string;
  status?: AssignmentStatus;
  assigneeUserId?: string;
  dueAt?: string;
}) {
  await assertClientAdmin(input.clientId, input.userId);

  const patch: Record<string, string | null> = {};

  if (input.status) {
    patch.status = input.status;
    if (input.status === "cancelled") {
      patch.completed_at = null;
      patch.inspection_id = null;
    }
  }

  if (input.assigneeUserId) {
    patch.assignee_user_id = input.assigneeUserId;
  }

  if (input.dueAt) {
    patch.due_at = new Date(input.dueAt).toISOString();
  }

  if (!Object.keys(patch).length) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("inspection_assignments")
    .update(patch)
    .eq("id", input.assignmentId)
    .eq("client_id", input.clientId);

  if (error) {
    throw new Error(error.message);
  }
}
