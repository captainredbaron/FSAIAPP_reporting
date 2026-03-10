import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { REPORTS_BUCKET, buildInspectionReportPath } from "@/lib/reports/inspection-reports";

export type ReportKind = "summary" | "full";
export type ReportVersionStatus = "queued" | "generating" | "completed" | "failed";

export interface ReportVersionRecord {
  id: string;
  inspection_id: string;
  user_id: string;
  report_kind: ReportKind;
  template_version: string;
  data_hash: string;
  version_no: number;
  status: ReportVersionStatus;
  storage_bucket: string | null;
  storage_path: string | null;
  page_count: number | null;
  asset_manifest_json: Record<string, unknown>;
  generated_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface LatestPointerRecord {
  inspection_id: string;
  user_id: string;
  summary_version_id: string | null;
  full_version_id: string | null;
  last_error: string | null;
  last_updated_at: string;
  created_at: string;
  updated_at: string;
}

interface ReportJobRecord {
  id: string;
  inspection_id: string;
  user_id: string;
  report_kind: ReportKind;
  template_version: string;
  target_version_id: string | null;
  status: "pending" | "running" | "retry" | "completed" | "failed" | "dead_letter";
  priority: number;
  attempt_count: number;
  max_attempts: number;
  next_run_at: string;
  locked_at: string | null;
  lock_owner: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  stage_error: string | null;
  created_at: string;
  updated_at: string;
}

interface InspectionForHash {
  id: string;
  user_id: string;
  status: string;
  location: string | null;
  note: string | null;
  overall_risk: string | null;
  compliance_status: string | null;
  compliance_score: number | null;
  summary: string | null;
  created_at: string;
  completed_at: string | null;
}

interface HashSection {
  section_code: string;
  section_title: string;
  sort_order: number;
}

interface HashFinding {
  id: string;
  section_code: string;
  title: string;
  severity: string;
  recommendation: string;
}

interface HashAssessment {
  section_code: string;
  compliance_status: string;
  score: number;
  rationale: string;
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export async function computeInspectionDataHash(inspectionId: string, userId: string) {
  const [inspectionResponse, sectionsResponse, findingsResponse, assessmentsResponse] = await Promise.all([
    supabaseAdmin
      .from("inspections")
      .select(
        "id,user_id,status,location,note,overall_risk,compliance_status,compliance_score,summary,created_at,completed_at"
      )
      .eq("id", inspectionId)
      .eq("user_id", userId)
      .single(),
    supabaseAdmin
      .from("inspection_checklist_sections")
      .select("section_code,section_title,sort_order")
      .eq("inspection_id", inspectionId)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("findings")
      .select("id,section_code,title,severity,recommendation")
      .eq("inspection_id", inspectionId)
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("section_assessments")
      .select("section_code,compliance_status,score,rationale")
      .eq("inspection_id", inspectionId)
      .order("created_at", { ascending: true })
  ]);

  if (inspectionResponse.error || !inspectionResponse.data) {
    throw new Error(inspectionResponse.error?.message || "Inspection not found while computing hash");
  }

  const inspection = inspectionResponse.data as InspectionForHash;
  const sections = (sectionsResponse.data ?? []) as HashSection[];
  const findings = (findingsResponse.data ?? []) as HashFinding[];
  const assessments = (assessmentsResponse.data ?? []) as HashAssessment[];

  const payload = {
    inspection,
    sections,
    findings,
    assessments
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function getNextVersionNo(inspectionId: string, kind: ReportKind) {
  const { data, error } = await supabaseAdmin
    .from("inspection_report_versions")
    .select("version_no")
    .eq("inspection_id", inspectionId)
    .eq("report_kind", kind)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to calculate next version number: ${error.message}`);
  }

  return (data?.version_no ?? 0) + 1;
}

export async function ensureReportLatestPointer(inspectionId: string, userId: string) {
  const payload = {
    inspection_id: inspectionId,
    user_id: userId,
    last_updated_at: new Date().toISOString()
  };

  const [{ error: latestError }, { error: compatibilityError }] = await Promise.all([
    supabaseAdmin.from("inspection_report_latest").upsert(payload, { onConflict: "inspection_id" }),
    supabaseAdmin
      .from("inspection_reports")
      .upsert(
        {
          inspection_id: inspectionId,
          user_id: userId,
          status: "pending",
          storage_bucket: REPORTS_BUCKET,
          storage_path: buildInspectionReportPath(userId, inspectionId),
          source_completed_at: new Date().toISOString(),
          last_updated_at: new Date().toISOString()
        },
        { onConflict: "inspection_id" }
      )
  ]);

  if (latestError) {
    throw new Error(`Failed to upsert inspection_report_latest: ${latestError.message}`);
  }

  if (compatibilityError && compatibilityError.code !== "PGRST204") {
    throw new Error(`Failed to sync inspection_reports pointer: ${compatibilityError.message}`);
  }
}

export async function findOrCreateVersion(params: {
  inspectionId: string;
  userId: string;
  kind: ReportKind;
  templateVersion: string;
  dataHash: string;
}) {
  const { inspectionId, userId, kind, templateVersion, dataHash } = params;

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("inspection_report_versions")
    .select(
      "id,inspection_id,user_id,report_kind,template_version,data_hash,version_no,status,storage_bucket,storage_path,page_count,asset_manifest_json,generated_at,error_message,created_at,updated_at"
    )
    .eq("inspection_id", inspectionId)
    .eq("report_kind", kind)
    .eq("template_version", templateVersion)
    .eq("data_hash", dataHash)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to lookup existing report version: ${existingError.message}`);
  }

  if (existing) {
    return {
      version: {
        ...(existing as ReportVersionRecord),
        asset_manifest_json: asJsonObject((existing as ReportVersionRecord).asset_manifest_json)
      },
      created: false
    };
  }

  const nextVersionNo = await getNextVersionNo(inspectionId, kind);
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("inspection_report_versions")
    .insert({
      inspection_id: inspectionId,
      user_id: userId,
      report_kind: kind,
      template_version: templateVersion,
      data_hash: dataHash,
      version_no: nextVersionNo,
      status: "queued",
      asset_manifest_json: {}
    })
    .select(
      "id,inspection_id,user_id,report_kind,template_version,data_hash,version_no,status,storage_bucket,storage_path,page_count,asset_manifest_json,generated_at,error_message,created_at,updated_at"
    )
    .single();

  if (insertError || !inserted) {
    throw new Error(`Failed to insert report version: ${insertError?.message || "unknown"}`);
  }

  return {
    version: {
      ...(inserted as ReportVersionRecord),
      asset_manifest_json: asJsonObject((inserted as ReportVersionRecord).asset_manifest_json)
    },
    created: true
  };
}

async function hasActiveJob(targetVersionId: string) {
  const { data, error } = await supabaseAdmin
    .from("report_jobs")
    .select("id")
    .eq("target_version_id", targetVersionId)
    .in("status", ["pending", "running", "retry"])
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to query active jobs: ${error.message}`);
  }

  return Boolean(data?.id);
}

export async function enqueueJobForVersion(params: {
  inspectionId: string;
  userId: string;
  kind: ReportKind;
  templateVersion: string;
  targetVersionId: string;
  priority: number;
  force?: boolean;
}) {
  const { inspectionId, userId, kind, templateVersion, targetVersionId, priority, force = false } = params;

  if (!force) {
    const exists = await hasActiveJob(targetVersionId);
    if (exists) {
      return null;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("report_jobs")
    .insert({
      inspection_id: inspectionId,
      user_id: userId,
      report_kind: kind,
      template_version: templateVersion,
      target_version_id: targetVersionId,
      status: "pending",
      priority,
      attempt_count: 0,
      max_attempts: 8,
      next_run_at: new Date().toISOString()
    })
    .select(
      "id,inspection_id,user_id,report_kind,template_version,target_version_id,status,priority,attempt_count,max_attempts,next_run_at,locked_at,lock_owner,started_at,completed_at,last_error,stage_error,created_at,updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(`Failed to enqueue report job: ${error?.message || "unknown"}`);
  }

  return data as ReportJobRecord;
}

export async function enqueueReportJobsForInspection(params: {
  inspectionId: string;
  userId: string;
  templateVersion?: string;
  force?: boolean;
  kinds?: ReportKind[];
}) {
  const {
    inspectionId,
    userId,
    templateVersion = "v2",
    force = false,
    kinds = ["summary", "full"]
  } = params;

  await ensureReportLatestPointer(inspectionId, userId);

  const hash = await computeInspectionDataHash(inspectionId, userId);
  const createdJobs: ReportJobRecord[] = [];

  for (const kind of kinds) {
    const { version } = await findOrCreateVersion({
      inspectionId,
      userId,
      kind,
      templateVersion,
      dataHash: hash
    });

    if (version.status === "completed" && !force) {
      continue;
    }

    const job = await enqueueJobForVersion({
      inspectionId,
      userId,
      kind,
      templateVersion,
      targetVersionId: version.id,
      priority: kind === "summary" ? 10 : 50,
      force
    });

    if (job) {
      createdJobs.push(job);
    }
  }

  return {
    dataHash: hash,
    createdJobs
  };
}

export async function requeueReportJob(params: {
  inspectionId: string;
  userId: string;
  kind: ReportKind;
  templateVersion?: string;
}) {
  return enqueueReportJobsForInspection({
    inspectionId: params.inspectionId,
    userId: params.userId,
    templateVersion: params.templateVersion ?? "v2",
    force: true,
    kinds: [params.kind]
  });
}

export async function getLatestReportStatus(inspectionId: string, userId: string) {
  const { data: latestRow, error: latestError } = await supabaseAdmin
    .from("inspection_report_latest")
    .select(
      "inspection_id,user_id,summary_version_id,full_version_id,last_error,last_updated_at,created_at,updated_at"
    )
    .eq("inspection_id", inspectionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (latestError) {
    throw new Error(`Failed to load latest report pointers: ${latestError.message}`);
  }

  const latest = (latestRow ?? null) as LatestPointerRecord | null;
  if (!latest) {
    return {
      latest: null,
      summary: null,
      full: null
    };
  }

  const versionIds = [latest.summary_version_id, latest.full_version_id].filter(
    (value): value is string => Boolean(value)
  );

  let versions = new Map<string, ReportVersionRecord>();
  if (versionIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("inspection_report_versions")
      .select(
        "id,inspection_id,user_id,report_kind,template_version,data_hash,version_no,status,storage_bucket,storage_path,page_count,asset_manifest_json,generated_at,error_message,created_at,updated_at"
      )
      .in("id", versionIds);

    if (error) {
      throw new Error(`Failed to load report versions: ${error.message}`);
    }

    versions = new Map((data ?? []).map((row) => [row.id, row as ReportVersionRecord]));
  }

  return {
    latest,
    summary: latest.summary_version_id ? versions.get(latest.summary_version_id) ?? null : null,
    full: latest.full_version_id ? versions.get(latest.full_version_id) ?? null : null
  };
}

export async function syncCompatibilityPointerFromLatest(inspectionId: string, userId: string) {
  const status = await getLatestReportStatus(inspectionId, userId);

  const full = status.full;
  const summary = status.summary;

  const preferred = full?.status === "completed" ? full : summary?.status === "completed" ? summary : null;

  const compatibilityStatus = preferred
    ? "completed"
    : full?.status === "failed" || summary?.status === "failed"
      ? "failed"
      : "pending";

  const payload = {
    inspection_id: inspectionId,
    user_id: userId,
    status: compatibilityStatus,
    storage_bucket: preferred?.storage_bucket ?? REPORTS_BUCKET,
    storage_path: preferred?.storage_path ?? buildInspectionReportPath(userId, inspectionId),
    summary_version_id: summary?.id ?? null,
    full_version_id: full?.id ?? null,
    generated_at: preferred?.generated_at ?? null,
    error_message: full?.error_message ?? summary?.error_message ?? null,
    last_error: status.latest?.last_error ?? null,
    last_updated_at: new Date().toISOString()
  };

  const { error } = await supabaseAdmin
    .from("inspection_reports")
    .upsert(payload, { onConflict: "inspection_id" });

  if (error && error.code !== "PGRST204") {
    throw new Error(`Failed to sync compatibility inspection_reports pointer: ${error.message}`);
  }
}

export function classifyStageError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }

  const text = error.message.toLowerCase();
  if (text.includes("thumbnail") || text.includes("asset")) return "asset_failed";
  if (text.includes("pdf") || text.includes("chromium") || text.includes("render")) return "render_failed";
  if (text.includes("upload") || text.includes("storage")) return "upload_failed";
  return "unknown";
}
