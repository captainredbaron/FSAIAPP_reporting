import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  createAssignment,
  listAssignments,
  updateAssignment,
  type AssignmentStatus
} from "@/lib/admin/client-admin";

const createAssignmentPayloadSchema = z.object({
  client_id: z.string().uuid(),
  location_id: z.string().uuid(),
  assignee_user_id: z.string().uuid(),
  checklist_version_id: z.string().uuid(),
  due_at: z.string().min(1)
});

const updateAssignmentPayloadSchema = z.object({
  client_id: z.string().uuid(),
  assignment_id: z.string().uuid(),
  status: z
    .enum(["pending", "in_progress", "completed", "overdue", "cancelled"])
    .optional(),
  assignee_user_id: z.string().uuid().optional(),
  due_at: z.string().optional()
});

const validStatuses = new Set<AssignmentStatus>([
  "pending",
  "in_progress",
  "completed",
  "overdue",
  "cancelled"
]);

export const runtime = "nodejs";

async function getCurrentUserId() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function GET(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get("client_id");
  const rawStatus = searchParams.get("status");

  if (!clientId) {
    return NextResponse.json({ error: "client_id is required" }, { status: 400 });
  }

  let status: AssignmentStatus | "all" = "all";
  if (rawStatus && validStatuses.has(rawStatus as AssignmentStatus)) {
    status = rawStatus as AssignmentStatus;
  }

  try {
    const assignments = await listAssignments({
      userId,
      clientId,
      status
    });

    return NextResponse.json({ assignments });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load assignments.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: z.infer<typeof createAssignmentPayloadSchema>;
  try {
    payload = createAssignmentPayloadSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  try {
    const assignmentId = await createAssignment({
      userId,
      clientId: payload.client_id,
      locationId: payload.location_id,
      assigneeUserId: payload.assignee_user_id,
      checklistVersionId: payload.checklist_version_id,
      dueAt: payload.due_at
    });

    return NextResponse.json({ assignment_id: assignmentId }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create assignment.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: z.infer<typeof updateAssignmentPayloadSchema>;
  try {
    payload = updateAssignmentPayloadSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  try {
    await updateAssignment({
      userId,
      clientId: payload.client_id,
      assignmentId: payload.assignment_id,
      status: payload.status,
      assigneeUserId: payload.assignee_user_id,
      dueAt: payload.due_at
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update assignment.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
