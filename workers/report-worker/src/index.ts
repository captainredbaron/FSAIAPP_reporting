import { createHash } from "node:crypto";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import type { ChartConfiguration } from "chart.js";
import { chromium } from "playwright";
import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REPORTS_BUCKET: z.string().default("inspection-reports"),
  REPORT_ASSETS_BUCKET: z.string().default("inspection-report-assets"),
  REPORT_TEMPLATE_VERSION: z.string().default("v2"),
  WORKER_ID: z.string().default(`cloud-run-${os.hostname()}`),
  POLL_INTERVAL_MS: z.coerce.number().default(5000),
  CLAIM_BATCH_SIZE: z.coerce.number().default(1),
  MAX_SUMMARY_IMAGES: z.coerce.number().default(4),
  MAX_FULL_IMAGES: z.coerce.number().default(12),
  SUMMARY_RENDER_TIMEOUT_MS: z.coerce.number().default(45_000),
  FULL_RENDER_TIMEOUT_MS: z.coerce.number().default(180_000)
});

const env = envSchema.parse({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  REPORTS_BUCKET: process.env.REPORTS_BUCKET,
  REPORT_ASSETS_BUCKET: process.env.REPORT_ASSETS_BUCKET,
  REPORT_TEMPLATE_VERSION: process.env.REPORT_TEMPLATE_VERSION,
  WORKER_ID: process.env.WORKER_ID,
  POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS,
  CLAIM_BATCH_SIZE: process.env.CLAIM_BATCH_SIZE,
  MAX_SUMMARY_IMAGES: process.env.MAX_SUMMARY_IMAGES,
  MAX_FULL_IMAGES: process.env.MAX_FULL_IMAGES,
  SUMMARY_RENDER_TIMEOUT_MS: process.env.SUMMARY_RENDER_TIMEOUT_MS,
  FULL_RENDER_TIMEOUT_MS: process.env.FULL_RENDER_TIMEOUT_MS
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const chartRenderer = new ChartJSNodeCanvas({
  width: 1000,
  height: 340,
  backgroundColour: "white"
});

type ReportKind = "summary" | "full";
type JobStatus = "pending" | "running" | "retry" | "completed" | "failed" | "dead_letter";
type VersionStatus = "queued" | "generating" | "completed" | "failed";

interface ReportJob {
  id: string;
  inspection_id: string;
  user_id: string;
  report_kind: ReportKind;
  template_version: string;
  target_version_id: string | null;
  status: JobStatus;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  next_run_at: string;
  lock_owner: string | null;
  locked_at: string | null;
  last_error: string | null;
}

interface ReportVersion {
  id: string;
  inspection_id: string;
  user_id: string;
  report_kind: ReportKind;
  template_version: string;
  data_hash: string;
  version_no: number;
  status: VersionStatus;
  storage_bucket: string | null;
  storage_path: string | null;
  page_count?: number | null;
  generated_at?: string | null;
  error_message?: string | null;
  asset_manifest_json: Record<string, unknown>;
}

interface InspectionRecord {
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

interface SectionRecord {
  id: string;
  section_code: string;
  section_title: string;
  sort_order: number;
}

interface FindingRecord {
  id: string;
  section_code: string;
  section_title: string;
  title: string;
  description: string;
  severity: string;
  confidence: number;
  recommendation: string;
}

interface AssessmentRecord {
  section_code: string;
  section_title: string;
  compliance_status: string;
  score: number;
  rationale: string;
}

interface ImageRecord {
  inspection_checklist_section_id: string;
  storage_path: string;
}

interface Snapshot {
  inspection: InspectionRecord;
  sections: SectionRecord[];
  findings: FindingRecord[];
  assessments: AssessmentRecord[];
  images: ImageRecord[];
}

interface StagedAsset {
  assetType: string;
  assetKey: string;
  bucket: string;
  path: string;
  mimeType: string;
  bytes: number;
  dataUrl: string;
  metadata: Record<string, unknown>;
}

let shuttingDown = false;

function log(event: string, payload: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      worker_id: env.WORKER_ID,
      event,
      ...payload
    })
  );
}

function toDataUrl(mimeType: string, buffer: Buffer) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function safeText(value?: string | null) {
  if (!value?.trim()) return "-";
  return value.trim();
}

function truncate(value: string, max = 260) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function classifyStageError(error: unknown) {
  if (!(error instanceof Error)) return "unknown";

  const message = error.message.toLowerCase();
  if (message.includes("thumbnail") || message.includes("asset") || message.includes("chart")) {
    return "asset_failed";
  }
  if (message.includes("render") || message.includes("chromium") || message.includes("pdf")) {
    return "render_failed";
  }
  if (message.includes("upload") || message.includes("storage")) {
    return "upload_failed";
  }
  return "unknown";
}

function backoffMs(attempt: number) {
  const base = Math.min(60 * 60 * 1000, 10_000 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 2_500);
  return base + jitter;
}

async function withTimeout<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function claimJobs(): Promise<ReportJob[]> {
  const { data, error } = await supabase.rpc("claim_report_jobs", {
    p_worker_id: env.WORKER_ID,
    p_limit: env.CLAIM_BATCH_SIZE
  });

  if (error) {
    throw new Error(`claim_report_jobs failed: ${error.message}`);
  }

  return (data ?? []) as ReportJob[];
}

async function recoverStaleJobs() {
  const { data, error } = await supabase.rpc("reset_stale_report_jobs", {
    p_stale_minutes: 15
  });

  if (error) {
    log("stale_recovery_error", { error: error.message });
    return;
  }

  const recovered = Number(data ?? 0);
  if (recovered > 0) {
    log("stale_jobs_recovered", { recovered });
  }
}

async function loadVersion(versionId: string) {
  const { data, error } = await supabase
    .from("inspection_report_versions")
    .select(
      "id,inspection_id,user_id,report_kind,template_version,data_hash,version_no,status,storage_bucket,storage_path,asset_manifest_json"
    )
    .eq("id", versionId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load target version: ${error?.message || "missing"}`);
  }

  const row = data as ReportVersion;
  row.asset_manifest_json = (row.asset_manifest_json ?? {}) as Record<string, unknown>;
  return row;
}

async function markVersionStatus(versionId: string, payload: Partial<ReportVersion>) {
  const { error } = await supabase
    .from("inspection_report_versions")
    .update({
      ...payload,
      updated_at: new Date().toISOString()
    })
    .eq("id", versionId);

  if (error) {
    throw new Error(`Failed to update report version status: ${error.message}`);
  }
}

async function markJobCompleted(job: ReportJob) {
  const { error } = await supabase
    .from("report_jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      lock_owner: null,
      locked_at: null,
      stage_error: null,
      last_error: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", job.id);

  if (error) {
    throw new Error(`Failed to mark job completed: ${error.message}`);
  }
}

async function markJobFailure(job: ReportJob, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown report worker error";
  const stageError = classifyStageError(error);
  const nextAttempt = job.attempt_count + 1;
  const terminal = nextAttempt >= job.max_attempts;
  const nextRunAt = new Date(Date.now() + backoffMs(nextAttempt)).toISOString();

  const { error: updateError } = await supabase
    .from("report_jobs")
    .update({
      status: terminal ? "dead_letter" : "retry",
      attempt_count: nextAttempt,
      next_run_at: terminal ? new Date().toISOString() : nextRunAt,
      lock_owner: null,
      locked_at: null,
      stage_error: stageError,
      last_error: message.slice(0, 4000),
      updated_at: new Date().toISOString()
    })
    .eq("id", job.id);

  if (updateError) {
    log("job_failure_update_error", {
      job_id: job.id,
      error: updateError.message
    });
  }

  return {
    stageError,
    message,
    terminal
  };
}

async function loadSnapshot(version: ReportVersion): Promise<Snapshot> {
  const { inspection_id: inspectionId, user_id: userId, report_kind: kind } = version;

  const sectionLimit = kind === "summary" ? 8 : 24;
  const findingsLimit = kind === "summary" ? 40 : 300;
  const assessmentsLimit = kind === "summary" ? 30 : 180;

  const [inspectionResponse, sectionsResponse, findingsResponse, assessmentsResponse] = await Promise.all([
    supabase
      .from("inspections")
      .select(
        "id,user_id,status,location,note,overall_risk,compliance_status,compliance_score,summary,created_at,completed_at"
      )
      .eq("id", inspectionId)
      .eq("user_id", userId)
      .single(),
    supabase
      .from("inspection_checklist_sections")
      .select("id,section_code,section_title,sort_order")
      .eq("inspection_id", inspectionId)
      .order("sort_order", { ascending: true })
      .limit(sectionLimit),
    supabase
      .from("findings")
      .select(
        "id,section_code,section_title,title,description,severity,confidence,recommendation"
      )
      .eq("inspection_id", inspectionId)
      .order("created_at", { ascending: true })
      .limit(findingsLimit),
    supabase
      .from("section_assessments")
      .select("section_code,section_title,compliance_status,score,rationale")
      .eq("inspection_id", inspectionId)
      .order("created_at", { ascending: true })
      .limit(assessmentsLimit)
  ]);

  if (inspectionResponse.error || !inspectionResponse.data) {
    throw new Error(`Snapshot inspection load failed: ${inspectionResponse.error?.message || "missing"}`);
  }

  const sections = (sectionsResponse.data ?? []) as SectionRecord[];
  const sectionIds = sections.map((s) => s.id);

  let images: ImageRecord[] = [];
  if (sectionIds.length > 0) {
    const imageLimit = kind === "summary" ? 24 : 120;
    const imageResponse = await supabase
      .from("inspection_checklist_images")
      .select("inspection_checklist_section_id,storage_path")
      .in("inspection_checklist_section_id", sectionIds)
      .limit(imageLimit);

    if (imageResponse.error) {
      throw new Error(`Snapshot image load failed: ${imageResponse.error.message}`);
    }

    images = (imageResponse.data ?? []) as ImageRecord[];
  }

  return {
    inspection: inspectionResponse.data as InspectionRecord,
    sections,
    findings: (findingsResponse.data ?? []) as FindingRecord[],
    assessments: (assessmentsResponse.data ?? []) as AssessmentRecord[],
    images
  };
}

async function uploadAsset(params: {
  version: ReportVersion;
  assetType: string;
  assetKey: string;
  mimeType: string;
  buffer: Buffer;
  metadata?: Record<string, unknown>;
}) {
  const { version, assetType, assetKey, mimeType, buffer, metadata = {} } = params;
  const storagePath = `${version.user_id}/${version.inspection_id}/${version.id}/${assetType}/${assetKey}`;

  const { error: uploadError } = await supabase.storage
    .from(env.REPORT_ASSETS_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType,
      upsert: true,
      cacheControl: "3600"
    });

  if (uploadError) {
    throw new Error(`Asset upload failed: ${uploadError.message}`);
  }

  const { error: rowError } = await supabase.from("inspection_report_assets").upsert(
    {
      version_id: version.id,
      inspection_id: version.inspection_id,
      user_id: version.user_id,
      asset_type: assetType,
      asset_key: assetKey,
      storage_bucket: env.REPORT_ASSETS_BUCKET,
      storage_path: storagePath,
      mime_type: mimeType,
      bytes: buffer.byteLength,
      metadata_json: metadata
    },
    { onConflict: "version_id,asset_type,asset_key" }
  );

  if (rowError) {
    throw new Error(`Asset row upsert failed: ${rowError.message}`);
  }

  return {
    assetType,
    assetKey,
    bucket: env.REPORT_ASSETS_BUCKET,
    path: storagePath,
    mimeType,
    bytes: buffer.byteLength,
    dataUrl: toDataUrl(mimeType, buffer),
    metadata
  } as StagedAsset;
}

async function fetchThumbnailBuffer(pathValue: string, timeoutMs = 1_800) {
  const { data, error } = await supabase.storage.from("inspection-images").createSignedUrl(pathValue, 60);

  if (error || !data?.signedUrl) {
    return null;
  }

  const thumbnailUrl = `${data.signedUrl}${data.signedUrl.includes("?") ? "&" : "?"}width=280&height=190&quality=35`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(thumbnailUrl, {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) return null;

    const raw = await response.arrayBuffer();
    return Buffer.from(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function stageThumbnailAssets(version: ReportVersion, snapshot: Snapshot) {
  const maxImages = version.report_kind === "summary" ? env.MAX_SUMMARY_IMAGES : env.MAX_FULL_IMAGES;

  const uniquePaths: string[] = [];
  for (const image of snapshot.images) {
    if (!uniquePaths.includes(image.storage_path)) {
      uniquePaths.push(image.storage_path);
    }
    if (uniquePaths.length >= maxImages) {
      break;
    }
  }

  const assets: StagedAsset[] = [];

  for (let i = 0; i < uniquePaths.length; i += 1) {
    const pathValue = uniquePaths[i];
    const buffer = await fetchThumbnailBuffer(pathValue);

    if (!buffer) {
      continue;
    }

    const uploaded = await uploadAsset({
      version,
      assetType: "thumbnail",
      assetKey: `thumb-${i + 1}.jpg`,
      mimeType: "image/jpeg",
      buffer,
      metadata: {
        source_path: pathValue,
        index: i
      }
    });

    assets.push(uploaded);
  }

  return assets;
}

function buildSeveritySeries(findings: FindingRecord[]) {
  const counters = new Map<string, number>();

  for (const finding of findings) {
    const key = finding.severity || "unknown";
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  const labels = [...counters.keys()];
  const values = labels.map((label) => counters.get(label) ?? 0);

  return {
    labels,
    values
  };
}

function buildComplianceSeries(assessments: AssessmentRecord[]) {
  const sorted = [...assessments].slice(0, 12);
  const labels = sorted.map((item) => item.section_code);
  const values = sorted.map((item) => Number(item.score ?? 0));

  return {
    labels,
    values
  };
}

async function renderChart(config: ChartConfiguration) {
  return chartRenderer.renderToBuffer(config, "image/png");
}

async function stageChartAssets(version: ReportVersion, snapshot: Snapshot) {
  const assets: StagedAsset[] = [];

  const severity = buildSeveritySeries(snapshot.findings);
  if (severity.labels.length > 0) {
    const severityChart = await renderChart({
      type: "bar",
      data: {
        labels: severity.labels,
        datasets: [
          {
            label: "Findings",
            data: severity.values,
            backgroundColor: ["#dc2626", "#ea580c", "#d97706", "#4f46e5", "#64748b"]
          }
        ]
      },
      options: {
        responsive: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: "Findings by Severity" }
        },
        scales: {
          y: { beginAtZero: true }
        }
      }
    });

    assets.push(
      await uploadAsset({
        version,
        assetType: "chart",
        assetKey: "severity.png",
        mimeType: "image/png",
        buffer: severityChart,
        metadata: {
          chart: "severity"
        }
      })
    );
  }

  const compliance = buildComplianceSeries(snapshot.assessments);
  if (compliance.labels.length > 0) {
    const complianceChart = await renderChart({
      type: "line",
      data: {
        labels: compliance.labels,
        datasets: [
          {
            label: "Section score",
            data: compliance.values,
            borderColor: "#0f766e",
            backgroundColor: "rgba(15,118,110,0.2)",
            tension: 0.2,
            fill: true
          }
        ]
      },
      options: {
        responsive: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: "Section Compliance Trend" }
        },
        scales: {
          y: { beginAtZero: true, max: 100 }
        }
      }
    });

    assets.push(
      await uploadAsset({
        version,
        assetType: "chart",
        assetKey: "compliance.png",
        mimeType: "image/png",
        buffer: complianceChart,
        metadata: {
          chart: "compliance"
        }
      })
    );
  }

  return assets;
}

function renderHtml(params: {
  version: ReportVersion;
  snapshot: Snapshot;
  charts: StagedAsset[];
  thumbnails: StagedAsset[];
}) {
  const { version, snapshot, charts, thumbnails } = params;

  const topFindings = snapshot.findings.slice(0, version.report_kind === "summary" ? 8 : 40);
  const topAssessments = snapshot.assessments.slice(0, version.report_kind === "summary" ? 8 : 60);

  const chartHtml = charts
    .map(
      (asset) => `
        <div class="card chart-card">
          <img src="${asset.dataUrl}" alt="${asset.assetKey}" />
        </div>
      `
    )
    .join("\n");

  const thumbnailsHtml = thumbnails
    .map(
      (asset) => `
        <div class="thumb-card">
          <img src="${asset.dataUrl}" alt="${asset.assetKey}" />
        </div>
      `
    )
    .join("\n");

  const assessmentsHtml = topAssessments
    .map(
      (item) => `
        <tr>
          <td>${item.section_code}</td>
          <td>${truncate(safeText(item.section_title), 100)}</td>
          <td>${safeText(item.compliance_status)}</td>
          <td>${Number(item.score ?? 0).toFixed(1)}</td>
        </tr>
      `
    )
    .join("\n");

  const findingsHtml = topFindings
    .map(
      (finding) => `
        <div class="finding">
          <h4>${truncate(safeText(finding.title), 120)}</h4>
          <p><strong>Section:</strong> ${safeText(finding.section_code)}</p>
          <p><strong>Severity:</strong> ${safeText(finding.severity)} | <strong>Confidence:</strong> ${Math.round(
            Number(finding.confidence ?? 0) * 100
          )}%</p>
          <p>${truncate(safeText(finding.description), version.report_kind === "summary" ? 260 : 520)}</p>
          <p><strong>Recommendation:</strong> ${truncate(
            safeText(finding.recommendation),
            version.report_kind === "summary" ? 260 : 520
          )}</p>
        </div>
      `
    )
    .join("\n");

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 24px; font-size: 12px; }
    h1 { margin: 0 0 8px 0; font-size: 22px; }
    h2 { margin: 24px 0 10px 0; font-size: 16px; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .card { border: 1px solid #d1d5db; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .thumb-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .thumb-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px; }
    .thumb-card img { width: 100%; height: auto; display: block; }
    .chart-card img { width: 100%; height: auto; display: block; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e5e7eb; padding: 6px; text-align: left; }
    th { background: #f3f4f6; }
    .finding { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; margin-bottom: 8px; }
    .muted { color: #6b7280; }
    .foot { margin-top: 20px; font-size: 11px; color: #6b7280; }
    @page { size: A4; margin: 16mm; }
  </style>
</head>
<body>
  <h1>Inspection Report (${version.report_kind.toUpperCase()})</h1>
  <div class="meta card">
    <div><strong>Inspection ID:</strong> ${snapshot.inspection.id}</div>
    <div><strong>Location:</strong> ${safeText(snapshot.inspection.location)}</div>
    <div><strong>Status:</strong> ${safeText(snapshot.inspection.status)}</div>
    <div><strong>Overall Risk:</strong> ${safeText(snapshot.inspection.overall_risk)}</div>
    <div><strong>Compliance:</strong> ${safeText(snapshot.inspection.compliance_status)}</div>
    <div><strong>Score:</strong> ${
      snapshot.inspection.compliance_score !== null
        ? Number(snapshot.inspection.compliance_score).toFixed(1)
        : "-"
    }</div>
  </div>

  <div class="card">
    <h2>Summary</h2>
    <p>${truncate(safeText(snapshot.inspection.summary), version.report_kind === "summary" ? 800 : 1800)}</p>
    <p class="muted">Template: ${version.template_version} | Data Hash: ${version.data_hash.slice(0, 16)}</p>
  </div>

  <h2>Charts</h2>
  <div class="grid">
    ${chartHtml || '<div class="muted">No chart data available.</div>'}
  </div>

  <h2>Photo Thumbnails</h2>
  <div class="thumb-grid">
    ${thumbnailsHtml || '<div class="muted">No thumbnails available.</div>'}
  </div>

  <h2>Section Assessments</h2>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Code</th>
          <th>Section</th>
          <th>Status</th>
          <th>Score</th>
        </tr>
      </thead>
      <tbody>
        ${assessmentsHtml || '<tr><td colspan="4">No assessments found.</td></tr>'}
      </tbody>
    </table>
  </div>

  <h2>Findings</h2>
  <div>
    ${findingsHtml || '<div class="muted">No findings found.</div>'}
  </div>

  <div class="foot">
    AI-assisted report for operational review. Not a legal determination.
  </div>
</body>
</html>
`.trim();
}

async function renderPdf(html: string) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1280,
        height: 1800
      }
    });

    await page.setContent(html, {
      waitUntil: "networkidle"
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "14mm",
        bottom: "14mm",
        left: "12mm",
        right: "12mm"
      }
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

function buildReportStoragePath(version: ReportVersion) {
  return `${version.user_id}/${version.inspection_id}/${version.report_kind}/v${version.version_no}/${version.id}.pdf`;
}

async function uploadPdf(version: ReportVersion, pdfBuffer: Buffer) {
  const storagePath = buildReportStoragePath(version);

  const { error } = await supabase.storage
    .from(env.REPORTS_BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
      cacheControl: "3600"
    });

  if (error) {
    throw new Error(`PDF upload failed: ${error.message}`);
  }

  return {
    storageBucket: env.REPORTS_BUCKET,
    storagePath
  };
}

async function updateLatestPointers(version: ReportVersion, errorMessage: string | null) {
  const latestPayload: Record<string, unknown> = {
    inspection_id: version.inspection_id,
    user_id: version.user_id,
    last_error: errorMessage,
    last_updated_at: new Date().toISOString()
  };

  if (!errorMessage) {
    if (version.report_kind === "summary") {
      latestPayload.summary_version_id = version.id;
    } else {
      latestPayload.full_version_id = version.id;
    }
  }

  const { error: latestError } = await supabase
    .from("inspection_report_latest")
    .upsert(latestPayload, { onConflict: "inspection_id" });

  if (latestError) {
    throw new Error(`Failed to update inspection_report_latest: ${latestError.message}`);
  }

  const compatibilityPayload: Record<string, unknown> = {
    inspection_id: version.inspection_id,
    user_id: version.user_id,
    last_error: errorMessage,
    last_updated_at: new Date().toISOString()
  };

  if (!errorMessage) {
    compatibilityPayload.status = "completed";
    compatibilityPayload.storage_bucket = version.storage_bucket;
    compatibilityPayload.storage_path = version.storage_path;
    compatibilityPayload.generated_at = new Date().toISOString();
    if (version.report_kind === "summary") {
      compatibilityPayload.summary_version_id = version.id;
    } else {
      compatibilityPayload.full_version_id = version.id;
    }
  } else {
    compatibilityPayload.status = "failed";
    compatibilityPayload.error_message = errorMessage.slice(0, 4000);
  }

  const { error: pointerError } = await supabase
    .from("inspection_reports")
    .upsert(compatibilityPayload, { onConflict: "inspection_id" });

  if (pointerError && pointerError.code !== "PGRST204") {
    throw new Error(`Failed to update compatibility pointer: ${pointerError.message}`);
  }
}

async function processJob(job: ReportJob) {
  const start = Date.now();
  log("job_started", {
    job_id: job.id,
    inspection_id: job.inspection_id,
    report_kind: job.report_kind,
    attempt: job.attempt_count + 1
  });

  if (!job.target_version_id) {
    throw new Error("target_version_id is missing on report job");
  }

  const version = await loadVersion(job.target_version_id);

  if (version.status === "completed" && version.storage_path && version.storage_bucket) {
    await markJobCompleted(job);
    await updateLatestPointers(version, null);
    log("job_short_circuit_completed", {
      job_id: job.id,
      version_id: version.id
    });
    return;
  }

  await markVersionStatus(version.id, {
    status: "generating",
    error_message: null
  });

  const snapshot = await withTimeout("snapshot_stage", 20_000, async () => loadSnapshot(version));

  const thumbnailAssets = await withTimeout(
    "thumbnail_stage",
    version.report_kind === "summary" ? 35_000 : 90_000,
    async () => stageThumbnailAssets(version, snapshot)
  );

  const chartAssets = await withTimeout(
    "chart_stage",
    version.report_kind === "summary" ? 30_000 : 60_000,
    async () => stageChartAssets(version, snapshot)
  );

  const html = renderHtml({
    version,
    snapshot,
    charts: chartAssets,
    thumbnails: thumbnailAssets
  });

  const renderTimeout =
    version.report_kind === "summary"
      ? env.SUMMARY_RENDER_TIMEOUT_MS
      : env.FULL_RENDER_TIMEOUT_MS;

  const pdfBuffer = await withTimeout("pdf_render_stage", renderTimeout, async () => renderPdf(html));

  const uploaded = await withTimeout("pdf_upload_stage", 30_000, async () =>
    uploadPdf(version, pdfBuffer)
  );

  const assetManifest = {
    template_version: version.template_version,
    staged_asset_count: thumbnailAssets.length + chartAssets.length,
    thumbnails: thumbnailAssets.map((asset) => ({
      key: asset.assetKey,
      path: asset.path,
      bytes: asset.bytes
    })),
    charts: chartAssets.map((asset) => ({
      key: asset.assetKey,
      path: asset.path,
      bytes: asset.bytes
    })),
    snapshot_hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
  };

  await markVersionStatus(version.id, {
    status: "completed",
    storage_bucket: uploaded.storageBucket,
    storage_path: uploaded.storagePath,
    generated_at: new Date().toISOString(),
    error_message: null,
    page_count: null,
    asset_manifest_json: assetManifest
  });

  const reloadedVersion = await loadVersion(version.id);
  reloadedVersion.storage_bucket = uploaded.storageBucket;
  reloadedVersion.storage_path = uploaded.storagePath;

  await updateLatestPointers(reloadedVersion, null);
  await markJobCompleted(job);

  log("job_completed", {
    job_id: job.id,
    version_id: version.id,
    report_kind: version.report_kind,
    duration_ms: Date.now() - start,
    staged_assets: thumbnailAssets.length + chartAssets.length,
    pdf_bytes: pdfBuffer.byteLength
  });
}

async function runJob(job: ReportJob) {
  try {
    await processJob(job);
  } catch (error) {
    const failure = await markJobFailure(job, error);

    if (job.target_version_id) {
      try {
        await markVersionStatus(job.target_version_id, {
          status: "failed",
          error_message: failure.message.slice(0, 4000)
        });

        const version = await loadVersion(job.target_version_id);
        await updateLatestPointers(version, failure.message);
      } catch (syncError) {
        log("version_sync_error", {
          job_id: job.id,
          error: syncError instanceof Error ? syncError.message : "unknown"
        });
      }
    }

    log("job_failed", {
      job_id: job.id,
      inspection_id: job.inspection_id,
      stage_error: failure.stageError,
      terminal: failure.terminal,
      error: failure.message
    });
  }
}

async function workerLoop() {
  log("worker_started", {
    poll_interval_ms: env.POLL_INTERVAL_MS,
    claim_batch_size: env.CLAIM_BATCH_SIZE,
    reports_bucket: env.REPORTS_BUCKET,
    assets_bucket: env.REPORT_ASSETS_BUCKET,
    template_version: env.REPORT_TEMPLATE_VERSION
  });

  while (!shuttingDown) {
    try {
      await recoverStaleJobs();
      const jobs = await claimJobs();

      if (jobs.length === 0) {
        await sleep(env.POLL_INTERVAL_MS);
        continue;
      }

      for (const job of jobs) {
        if (shuttingDown) {
          break;
        }

        await runJob(job);
      }
    } catch (error) {
      log("worker_loop_error", {
        error: error instanceof Error ? error.message : "unknown"
      });
      await sleep(env.POLL_INTERVAL_MS);
    }
  }

  log("worker_stopped", {});
}

process.on("SIGTERM", () => {
  shuttingDown = true;
  log("signal_received", { signal: "SIGTERM" });
});

process.on("SIGINT", () => {
  shuttingDown = true;
  log("signal_received", { signal: "SIGINT" });
});

workerLoop().catch((error) => {
  log("worker_fatal", {
    error: error instanceof Error ? error.message : "unknown"
  });
  process.exitCode = 1;
});
