import { NextResponse } from "next/server";
import {
  buildInspectionReportPath,
  downloadInspectionReportPdf,
  getInspectionReportRecord,
  REPORTS_BUCKET
} from "@/lib/reports/inspection-reports";
import { getLatestReportStatus } from "@/lib/reports/report-pipeline";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type InspectionStatus = "draft" | "queued" | "processing" | "completed" | "failed";
type RequestedKind = "summary" | "full" | "auto";

interface InspectionOwnershipRecord {
  id: string;
  user_id: string;
  status: InspectionStatus;
}

function parseRequestedKind(value: string | null): RequestedKind {
  if (value === "summary") return "summary";
  if (value === "full") return "full";
  return "auto";
}

export const runtime = "nodejs";
export const maxDuration = 20;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const requestedKind = parseRequestedKind(new URL(request.url).searchParams.get("kind"));

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
  if (inspectionRecord.status !== "completed") {
    return NextResponse.json(
      { error: "PDF report is available only after analysis is completed." },
      { status: 400 }
    );
  }

  const latest = await getLatestReportStatus(id, user.id);

  const preferredVersion =
    requestedKind === "summary"
      ? latest.summary
      : requestedKind === "full"
        ? latest.full
        : latest.full?.status === "completed"
          ? latest.full
          : latest.summary?.status === "completed"
            ? latest.summary
            : null;

  const candidateFiles = [] as Array<{ bucket: string; path: string; filenameKind: "summary" | "full" }>;

  if (preferredVersion?.status === "completed" && preferredVersion.storage_bucket && preferredVersion.storage_path) {
    candidateFiles.push({
      bucket: preferredVersion.storage_bucket,
      path: preferredVersion.storage_path,
      filenameKind: preferredVersion.report_kind
    });
  }

  const compatibility = await getInspectionReportRecord(id);
  if (compatibility.record?.storage_bucket && compatibility.record?.storage_path) {
    candidateFiles.push({
      bucket: compatibility.record.storage_bucket,
      path: compatibility.record.storage_path,
      filenameKind: requestedKind === "summary" ? "summary" : "full"
    });
  }

  candidateFiles.push({
    bucket: REPORTS_BUCKET,
    path: buildInspectionReportPath(user.id, id),
    filenameKind: requestedKind === "summary" ? "summary" : "full"
  });

  let pdfBlob: Blob | null = null;
  let resolvedKind: "summary" | "full" = requestedKind === "summary" ? "summary" : "full";

  for (const file of candidateFiles) {
    const maybeBlob = await downloadInspectionReportPdf(file.bucket, file.path);
    if (maybeBlob) {
      pdfBlob = maybeBlob;
      resolvedKind = file.filenameKind;
      break;
    }
  }

  if (!pdfBlob) {
    return NextResponse.json(
      {
        error: "Report is being prepared. Please retry in about one minute.",
        report_kind: requestedKind,
        summary_status: latest.summary?.status ?? "missing",
        full_status: latest.full?.status ?? "missing",
        last_error: latest.latest?.last_error ?? latest.full?.error_message ?? latest.summary?.error_message ?? null
      },
      { status: 409 }
    );
  }

  const fileBytes = await pdfBlob.arrayBuffer();
  const filename = `inspection-report-${resolvedKind}-${id}.pdf`;

  return new NextResponse(new Uint8Array(fileBytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename=\"${filename}\"`,
      "Cache-Control": "private, no-store"
    }
  });
}
