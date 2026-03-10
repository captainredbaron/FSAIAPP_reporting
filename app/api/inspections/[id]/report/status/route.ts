import { NextResponse } from "next/server";
import { getLatestReportStatus } from "@/lib/reports/report-pipeline";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 15;

interface InspectionOwnershipRecord {
  id: string;
  user_id: string;
  status: "draft" | "queued" | "processing" | "completed" | "failed";
}

function toSummary(version: Awaited<ReturnType<typeof getLatestReportStatus>>["summary"]) {
  if (!version) {
    return {
      status: "missing",
      version_id: null,
      ready: false,
      generated_at: null,
      error: null
    };
  }

  return {
    status: version.status,
    version_id: version.id,
    ready: version.status === "completed" && Boolean(version.storage_bucket && version.storage_path),
    generated_at: version.generated_at,
    error: version.error_message
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: inspection } = await supabase
    .from("inspections")
    .select("id,user_id,status")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!inspection) {
    return NextResponse.json({ error: "Inspection not found." }, { status: 404 });
  }

  const inspectionRecord = inspection as InspectionOwnershipRecord;
  const status = await getLatestReportStatus(id, inspectionRecord.user_id);

  const summary = toSummary(status.summary);
  const full = toSummary(status.full);

  const summaryUrl = summary.ready ? `/api/inspections/${id}/report?kind=summary` : null;
  const fullUrl = full.ready ? `/api/inspections/${id}/report?kind=full` : null;

  return NextResponse.json({
    inspection_id: id,
    inspection_status: inspectionRecord.status,
    summary,
    full,
    latest_version_ids: {
      summary: status.latest?.summary_version_id ?? null,
      full: status.latest?.full_version_id ?? null
    },
    download: {
      summary_url: summaryUrl,
      full_url: fullUrl
    },
    last_error: status.latest?.last_error ?? full.error ?? summary.error ?? null,
    last_updated_at: status.latest?.last_updated_at ?? null
  });
}
