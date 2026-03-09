import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const REPORTS_BUCKET = "inspection-reports";

export type InspectionReportStatus = "pending" | "generating" | "completed" | "failed";

export interface InspectionReportRow {
  inspection_id: string;
  user_id: string;
  status: InspectionReportStatus;
  storage_bucket: string | null;
  storage_path: string | null;
  error_message: string | null;
  generated_at: string | null;
  source_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface InspectionReportLookupResult {
  record: InspectionReportRow | null;
  tableAvailable: boolean;
}

function isReportsTableMissing(error: PostgrestError | null | undefined) {
  const message = error?.message ?? "";
  return (
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    message.includes("inspection_reports")
  );
}

export function buildInspectionReportPath(userId: string, inspectionId: string) {
  return `${userId}/${inspectionId}/inspection-report-${inspectionId}.pdf`;
}

export async function getInspectionReportRecord(
  inspectionId: string
): Promise<InspectionReportLookupResult> {
  const { data, error } = await supabaseAdmin
    .from("inspection_reports")
    .select(
      "inspection_id,user_id,status,storage_bucket,storage_path,error_message,generated_at,source_completed_at,created_at,updated_at"
    )
    .eq("inspection_id", inspectionId)
    .maybeSingle();

  if (error) {
    if (isReportsTableMissing(error)) {
      return { record: null, tableAvailable: false };
    }

    throw new Error(`Failed to query inspection_reports: ${error.message}`);
  }

  return {
    record: (data ?? null) as InspectionReportRow | null,
    tableAvailable: true
  };
}

export async function listInspectionReportsByInspectionIds(inspectionIds: string[]) {
  if (inspectionIds.length === 0) {
    return {
      reportsByInspectionId: new Map<string, InspectionReportRow>(),
      tableAvailable: true
    };
  }

  const { data, error } = await supabaseAdmin
    .from("inspection_reports")
    .select(
      "inspection_id,user_id,status,storage_bucket,storage_path,error_message,generated_at,source_completed_at,created_at,updated_at"
    )
    .in("inspection_id", inspectionIds);

  if (error) {
    if (isReportsTableMissing(error)) {
      return {
        reportsByInspectionId: new Map<string, InspectionReportRow>(),
        tableAvailable: false
      };
    }

    throw new Error(`Failed to list inspection_reports: ${error.message}`);
  }

  const rows = (data ?? []) as InspectionReportRow[];
  return {
    reportsByInspectionId: new Map(rows.map((row) => [row.inspection_id, row])),
    tableAvailable: true
  };
}

interface UpsertInspectionReportParams {
  inspectionId: string;
  userId: string;
  status: InspectionReportStatus;
  storageBucket?: string | null;
  storagePath?: string | null;
  errorMessage?: string | null;
  generatedAt?: string | null;
  sourceCompletedAt?: string | null;
}

export async function upsertInspectionReport(params: UpsertInspectionReportParams) {
  const {
    inspectionId,
    userId,
    status,
    storageBucket,
    storagePath,
    errorMessage,
    generatedAt,
    sourceCompletedAt
  } = params;

  const payload = {
    inspection_id: inspectionId,
    user_id: userId,
    status,
    storage_bucket: storageBucket ?? REPORTS_BUCKET,
    storage_path: storagePath ?? buildInspectionReportPath(userId, inspectionId),
    error_message: errorMessage ?? null,
    generated_at: generatedAt ?? null,
    source_completed_at: sourceCompletedAt ?? null
  };

  const { error } = await supabaseAdmin
    .from("inspection_reports")
    .upsert(payload, { onConflict: "inspection_id" });

  if (error) {
    if (isReportsTableMissing(error)) {
      return false;
    }

    throw new Error(`Failed to upsert inspection_reports: ${error.message}`);
  }

  return true;
}

export async function uploadInspectionReportPdf(
  userId: string,
  inspectionId: string,
  pdfBuffer: Buffer,
  bucket = REPORTS_BUCKET
) {
  const storagePath = buildInspectionReportPath(userId, inspectionId);

  const { error } = await supabaseAdmin.storage.from(bucket).upload(storagePath, pdfBuffer, {
    contentType: "application/pdf",
    upsert: true,
    cacheControl: "3600"
  });

  if (error) {
    throw new Error(`Failed to upload report PDF: ${error.message}`);
  }

  return {
    storageBucket: bucket,
    storagePath
  };
}

export async function downloadInspectionReportPdf(bucket: string, path: string) {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);

  if (error || !data) {
    return null;
  }

  return data;
}
