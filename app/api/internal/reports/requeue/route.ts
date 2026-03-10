import { NextResponse } from "next/server";
import { requeueReportJob } from "@/lib/reports/report-pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 15;

type ReportKind = "summary" | "full";

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

function parseKind(value: unknown): ReportKind {
  if (value === "summary") return "summary";
  return "full";
}

export async function POST(request: Request) {
  if (!hasValidToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: { inspection_id?: string; report_kind?: ReportKind; template_version?: string };

  try {
    payload = (await request.json()) as {
      inspection_id?: string;
      report_kind?: ReportKind;
      template_version?: string;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const inspectionId = payload.inspection_id?.trim();
  if (!inspectionId) {
    return NextResponse.json({ error: "inspection_id is required" }, { status: 400 });
  }

  const kind = parseKind(payload.report_kind);

  const { data: inspection, error: inspectionError } = await supabaseAdmin
    .from("inspections")
    .select("id,user_id,status")
    .eq("id", inspectionId)
    .single();

  if (inspectionError || !inspection) {
    return NextResponse.json(
      { error: inspectionError?.message || "Inspection not found" },
      { status: 404 }
    );
  }

  if (inspection.status !== "completed") {
    return NextResponse.json(
      { error: "Inspection is not completed; report requeue is blocked." },
      { status: 400 }
    );
  }

  const result = await requeueReportJob({
    inspectionId,
    userId: inspection.user_id,
    kind,
    templateVersion: payload.template_version || process.env.REPORT_TEMPLATE_VERSION || "v2"
  });

  return NextResponse.json({
    inspection_id: inspectionId,
    report_kind: kind,
    template_version: payload.template_version || process.env.REPORT_TEMPLATE_VERSION || "v2",
    enqueued_jobs: result.createdJobs.length,
    data_hash: result.dataHash.slice(0, 16)
  });
}
