import { NextResponse } from "next/server";
import {
  buildInspectionReportPath,
  downloadInspectionReportPdf,
  getInspectionReportRecord,
  REPORTS_BUCKET
} from "@/lib/reports/inspection-reports";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type InspectionStatus = "draft" | "queued" | "processing" | "completed" | "failed";

interface InspectionOwnershipRecord {
  id: string;
  user_id: string;
  status: InspectionStatus;
}

export const runtime = "nodejs";
export const maxDuration = 20;

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
  if (inspectionRecord.status !== "completed") {
    return NextResponse.json(
      { error: "PDF report is available only after analysis is completed." },
      { status: 400 }
    );
  }

  const reportLookup = await getInspectionReportRecord(id);
  const defaultPath = buildInspectionReportPath(user.id, id);
  const preferredBucket = reportLookup.record?.storage_bucket ?? REPORTS_BUCKET;
  const preferredPath = reportLookup.record?.storage_path ?? defaultPath;

  let pdfBlob = await downloadInspectionReportPdf(preferredBucket, preferredPath);
  if (!pdfBlob && preferredPath !== defaultPath) {
    pdfBlob = await downloadInspectionReportPdf(REPORTS_BUCKET, defaultPath);
  }

  if (!pdfBlob) {
    const status = reportLookup.record?.status ?? "pending";
    const errorMessage =
      status === "failed"
        ? reportLookup.record?.error_message || "Report generation failed. It will retry on cron."
        : "Report is being prepared. Please retry in about one minute.";

    return NextResponse.json(
      {
        error: errorMessage,
        report_status: status
      },
      { status: 409 }
    );
  }

  const filename = `inspection-report-${id}.pdf`;
  const fileBytes = await pdfBlob.arrayBuffer();

  return new NextResponse(new Uint8Array(fileBytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename=\"${filename}\"`,
      "Cache-Control": "private, no-store"
    }
  });
}
