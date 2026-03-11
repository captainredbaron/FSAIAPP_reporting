"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  createAssignment,
  createChecklistDraft,
  createClient,
  publishChecklistVersion,
  saveClientLocation,
  setClientUserRoleByEmail,
  updateAssignment,
  type AssignmentStatus,
  type ClientUserRole
} from "@/lib/admin/client-admin";

function parseRole(rawRole: FormDataEntryValue | null): ClientUserRole {
  const role = typeof rawRole === "string" ? rawRole : "";
  if (role === "owner" || role === "manager" || role === "auditor" || role === "viewer") {
    return role;
  }
  throw new Error("Invalid role.");
}

function parseAssignmentStatus(rawStatus: FormDataEntryValue | null): AssignmentStatus {
  const status = typeof rawStatus === "string" ? rawStatus : "";
  if (
    status === "pending" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "overdue" ||
    status === "cancelled"
  ) {
    return status;
  }
  throw new Error("Invalid assignment status.");
}

function parseChecklistSections(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [codeRaw, titleRaw, descriptionRaw] = line.split("|");
      return {
        section_code: (codeRaw ?? "").trim(),
        section_title: (titleRaw ?? "").trim(),
        description: (descriptionRaw ?? "").trim() || null
      };
    });
}

async function requireAuthUserId() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  return user.id;
}

export async function createClientAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const code = (formData.get("code") as string | null)?.trim() ?? "";

  await createClient({
    userId,
    name,
    code: code || null
  });

  revalidatePath("/reporting/admin");
}

export async function saveLocationAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const clientId = (formData.get("client_id") as string | null)?.trim() ?? "";
  const locationId = (formData.get("location_id") as string | null)?.trim() ?? null;
  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const address = (formData.get("address") as string | null)?.trim() ?? "";
  const activeRaw = (formData.get("active") as string | null)?.trim();

  await saveClientLocation({
    userId,
    clientId,
    locationId,
    name,
    address: address || null,
    active: activeRaw ? activeRaw === "true" : undefined
  });

  revalidatePath("/reporting/admin");
}

export async function setClientRoleAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const clientId = (formData.get("client_id") as string | null)?.trim() ?? "";
  const email = (formData.get("email") as string | null)?.trim() ?? "";
  const role = parseRole(formData.get("role"));

  await setClientUserRoleByEmail({
    userId,
    clientId,
    email,
    role
  });

  revalidatePath("/reporting/admin");
}

export async function createChecklistDraftAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const clientId = (formData.get("client_id") as string | null)?.trim() ?? "";
  const title = (formData.get("title") as string | null)?.trim() ?? "";
  const rawSections = (formData.get("sections") as string | null)?.trim() ?? "";
  const sections = parseChecklistSections(rawSections);

  await createChecklistDraft({
    userId,
    clientId,
    title,
    sections
  });

  revalidatePath("/reporting/admin");
}

export async function publishChecklistVersionAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const clientId = (formData.get("client_id") as string | null)?.trim() ?? "";
  const versionId = (formData.get("version_id") as string | null)?.trim() ?? "";

  await publishChecklistVersion({
    userId,
    clientId,
    versionId
  });

  revalidatePath("/reporting/admin");
}

export async function createAssignmentAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const clientId = (formData.get("client_id") as string | null)?.trim() ?? "";
  const locationId = (formData.get("location_id") as string | null)?.trim() ?? "";
  const assigneeUserId = (formData.get("assignee_user_id") as string | null)?.trim() ?? "";
  const checklistVersionId =
    (formData.get("checklist_version_id") as string | null)?.trim() ?? "";
  const dueAt = (formData.get("due_at") as string | null)?.trim() ?? "";

  await createAssignment({
    userId,
    clientId,
    locationId,
    assigneeUserId,
    checklistVersionId,
    dueAt
  });

  revalidatePath("/reporting/admin");
}

export async function updateAssignmentAction(formData: FormData) {
  const userId = await requireAuthUserId();
  const clientId = (formData.get("client_id") as string | null)?.trim() ?? "";
  const assignmentId = (formData.get("assignment_id") as string | null)?.trim() ?? "";
  const assigneeUserId =
    (formData.get("assignee_user_id") as string | null)?.trim() || undefined;
  const dueAt = (formData.get("due_at") as string | null)?.trim() || undefined;
  const status = parseAssignmentStatus(formData.get("status"));

  await updateAssignment({
    userId,
    clientId,
    assignmentId,
    status,
    assigneeUserId,
    dueAt
  });

  revalidatePath("/reporting/admin");
}
