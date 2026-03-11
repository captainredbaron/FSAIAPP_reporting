import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { publishChecklistVersion } from "@/lib/admin/client-admin";

const payloadSchema = z.object({
  client_id: z.string().uuid(),
  version_id: z.string().uuid()
});

export const runtime = "nodejs";

async function getCurrentUserId() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  try {
    await publishChecklistVersion({
      userId,
      clientId: payload.client_id,
      versionId: payload.version_id
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to publish checklist version.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
