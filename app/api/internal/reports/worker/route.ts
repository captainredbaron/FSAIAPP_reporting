import { NextResponse } from "next/server";
import { enqueueReportJobsForInspection } from "@/lib/reports/report-pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 20;

const CANDIDATE_LIMIT = 100;
const TEMPLATE_VERSION = process.env.REPORT_TEMPLATE_VERSION || "v2";

interface CompletedInspectionRecord {
  id: string;
  user_id: string;
  status: "draft" | "queued" | "processing" | "completed" | "failed";
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

async function recoverStaleJobs() {
  const { data, error } = await supabaseAdmin.rpc("reset_stale_report_jobs", {
    p_stale_minutes: 15
  });

  if (error) {
    return {
      recovered: 0,
      error: error.message
    };
  }

  return {
    recovered: Number(data ?? 0),
    error: null
  };
}

async function handleWork(request: Request) {
  if (!hasValidToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const requestedInspectionId = requestUrl.searchParams.get("inspection_id")?.trim() || null;
  const force = requestUrl.searchParams.get("force") === "1";

  const staleResult = await recoverStaleJobs();

  let inspectionsQuery = supabaseAdmin
    .from("inspections")
    .select("id,user_id,status,completed_at")
    .eq("status", "completed")
    .order("completed_at", { ascending: false, nullsFirst: false });

  if (requestedInspectionId) {
    inspectionsQuery = inspectionsQuery.eq("id", requestedInspectionId).limit(1);
  } else {
    inspectionsQuery = inspectionsQuery.limit(CANDIDATE_LIMIT);
  }

  const { data: completedInspections, error: inspectionsError } = await inspectionsQuery;

  if (inspectionsError) {
    return NextResponse.json(
      {
        error: `Failed to fetch completed inspections: ${inspectionsError.message}`,
        stale_recovered: staleResult.recovered,
        stale_error: staleResult.error
      },
      { status: 500 }
    );
  }

  const candidates = (completedInspections ?? []) as CompletedInspectionRecord[];
  if (!candidates.length) {
    return NextResponse.json({
      enqueued_jobs: 0,
      inspections_considered: 0,
      stale_recovered: staleResult.recovered,
      stale_error: staleResult.error,
      reason: "No completed inspections found."
    });
  }

  const results: Array<{ inspection_id: string; enqueued: number; hash?: string; error?: string }> = [];
  let totalJobs = 0;

  for (const inspection of candidates) {
    try {
      const enqueueResult = await enqueueReportJobsForInspection({
        inspectionId: inspection.id,
        userId: inspection.user_id,
        templateVersion: TEMPLATE_VERSION,
        force
      });

      const count = enqueueResult.createdJobs.length;
      totalJobs += count;

      results.push({
        inspection_id: inspection.id,
        enqueued: count,
        hash: enqueueResult.dataHash.slice(0, 16)
      });
    } catch (error) {
      results.push({
        inspection_id: inspection.id,
        enqueued: 0,
        error: error instanceof Error ? error.message : "Unknown enqueue error"
      });
    }
  }

  return NextResponse.json({
    enqueued_jobs: totalJobs,
    inspections_considered: candidates.length,
    stale_recovered: staleResult.recovered,
    stale_error: staleResult.error,
    force,
    template_version: TEMPLATE_VERSION,
    results
  });
}

export async function GET(request: Request) {
  return handleWork(request);
}

export async function POST(request: Request) {
  return handleWork(request);
}
