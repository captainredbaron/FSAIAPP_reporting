import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  createChecklistDraft,
  getChecklistSectionsByVersion,
  listClientChecklistVersions
} from "@/lib/admin/client-admin";

const createChecklistPayloadSchema = z.object({
  client_id: z.string().uuid(),
  title: z.string().min(1).max(160),
  sections: z
    .array(
      z.object({
        section_code: z.string().min(1).max(80),
        section_title: z.string().min(1).max(220),
        description: z.string().max(600).optional().nullable()
      })
    )
    .min(1)
});

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
  const versionId = searchParams.get("version_id");

  if (!clientId) {
    return NextResponse.json({ error: "client_id is required" }, { status: 400 });
  }

  try {
    const versions = await listClientChecklistVersions(clientId, userId);
    const sections =
      versionId && versions.some((version) => version.id === versionId)
        ? await getChecklistSectionsByVersion({
            clientId,
            versionId,
            userId
          })
        : [];

    return NextResponse.json({
      versions,
      sections
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load checklist versions.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: z.infer<typeof createChecklistPayloadSchema>;
  try {
    payload = createChecklistPayloadSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  try {
    const versionId = await createChecklistDraft({
      userId,
      clientId: payload.client_id,
      title: payload.title,
      sections: payload.sections
    });

    return NextResponse.json({ version_id: versionId }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create checklist draft.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
