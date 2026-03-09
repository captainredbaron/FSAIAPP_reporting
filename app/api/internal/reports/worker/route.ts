import { NextResponse } from "next/server";
import {
  buildInspectionReportPath,
  listInspectionReportsByInspectionIds,
  REPORTS_BUCKET,
  type InspectionReportRow,
  upsertInspectionReport,
  uploadInspectionReportPdf
} from "@/lib/reports/inspection-reports";
import { generateInspectionReportPdf } from "@/lib/reports/generate-inspection-report";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_REPORTS_PER_RUN = 1;
const CANDIDATE_LIMIT = 60;
const STALE_GENERATING_MS = 15 * 60 * 1000;

type InspectionStatus = "draft" | "queued" | "processing" | "completed" | "failed";

interface CompletedInspectionRecord {
  id: string;
  user_id: string;
  status: InspectionStatus;
  completed_at: string | null;
}

function hasValidToken(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  const provided = authHeader.slice("Bearer ".length).trim();
  if (!provided) {
    return false;
  }

  const validSecrets = [process.env.REPORTS_TRIGGER_SECRET, process.env.CRON_SECRET].filter(
    (value): value is string => Boolean(value?.trim())
  );

  return validSecrets.some((secret) => secret === provided);
}

function parseTime(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function reportNeedsGeneration(inspection: CompletedInspectionRecord, report?: InspectionReportRow) {
  if (!report) {
    return true;
  }

  if (report.status === "pending" || report.status === "failed") {
    return true;
  }

  if (report.status === "generating") {
    const updated = parseTime(report.updated_at);
    if (!updated) {
      return true;
    }

    return Date.now() - updated > STALE_GENERATING_MS;
  }

  if (!report.storage_path) {
    return true;
  }

  const reportGeneratedAt = parseTime(report.generated_at);
  const inspectionCompletedAt = parseTime(inspection.completed_at);

  if (inspectionCompletedAt && reportGeneratedAt && reportGeneratedAt < inspectionCompletedAt) {
    return true;
  }

  return false;
}

async function handleWork(request: Request) {
  if (!hasValidToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: completedInspections, error: inspectionsError } = await supabaseAdmin
    .from("inspections")
    .select("id,user_id,status,completed_at")
    .eq("status", "completed")
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(CANDIDATE_LIMIT);

  if (inspectionsError) {
    return NextResponse.json(
      { error: `Failed to fetch completed inspections: ${inspectionsError.message}` },
      { status: 500 }
    );
  }

  const candidates = (completedInspections ?? []) as CompletedInspectionRecord[];
  if (!candidates.length) {
    return NextResponse.json({ processed: 0, reason: "No completed inspections found." });
  }

  const inspectionIds = candidates.map((row) => row.id);
  const { reportsByInspectionId } = await listInspectionReportsByInspectionIds(inspectionIds);

  const targets = candidates
    .filter((inspection) =>
      reportNeedsGeneration(inspection, reportsByInspectionId.get(inspection.id))
    )
    .slice(0, MAX_REPORTS_PER_RUN);

  if (!targets.length) {
    return NextResponse.json({ processed: 0, reason: "No reports pending generation." });
  }

  const results: Array<{ inspection_id: string; status: string; detail?: string }> = [];

  for (const inspection of targets) {
    const plannedStoragePath = buildInspectionReportPath(inspection.user_id, inspection.id);

    try {
      await upsertInspectionReport({
        inspectionId: inspection.id,
        userId: inspection.user_id,
        status: "generating",
        storageBucket: REPORTS_BUCKET,
        storagePath: plannedStoragePath,
        errorMessage: null,
        sourceCompletedAt: inspection.completed_at
      });

      const pdfBuffer = await generateInspectionReportPdf(inspection.id, inspection.user_id);
      const uploaded = await uploadInspectionReportPdf(inspection.user_id, inspection.id, pdfBuffer);

      await upsertInspectionReport({
        inspectionId: inspection.id,
        userId: inspection.user_id,
        status: "completed",
        storageBucket: uploaded.storageBucket,
        storagePath: uploaded.storagePath,
        generatedAt: new Date().toISOString(),
        sourceCompletedAt: inspection.completed_at,
        errorMessage: null
      });

      results.push({ inspection_id: inspection.id, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown report generation error";

      await upsertInspectionReport({
        inspectionId: inspection.id,
        userId: inspection.user_id,
        status: "failed",
        storageBucket: REPORTS_BUCKET,
        storagePath: plannedStoragePath,
        sourceCompletedAt: inspection.completed_at,
        errorMessage: message.slice(0, 4000)
      });

      results.push({ inspection_id: inspection.id, status: "failed", detail: message });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}

export async function GET(request: Request) {
  return handleWork(request);
}

export async function POST(request: Request) {
  return handleWork(request);
}
