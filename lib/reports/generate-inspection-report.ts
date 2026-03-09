import { readFile } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { format } from "date-fns";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ComplianceStatus, OverallRisk, Severity } from "@/lib/types/domain";

interface InspectionRecord {
  id: string;
  user_id: string;
  status: "draft" | "queued" | "processing" | "completed" | "failed";
  location: string | null;
  note: string | null;
  overall_risk: OverallRisk | null;
  summary: string | null;
  compliance_status: ComplianceStatus | null;
  compliance_score: number | null;
  created_at: string;
}

interface ChecklistSectionRecord {
  id: string;
  section_code: string;
  section_title: string;
  sort_order: number;
}

interface ChecklistImageRecord {
  inspection_checklist_section_id: string;
  storage_path: string;
}

interface SectionAssessmentRecord {
  section_code: string;
  section_title: string;
  compliance_status: ComplianceStatus;
  score: number;
  rationale: string;
}

interface FindingRecord {
  id: string;
  section_code: string;
  section_title: string;
  title: string;
  description: string;
  severity: Severity;
  confidence: number;
  evidence: string;
  recommendation: string;
  rule_code: string;
  rule_title: string;
  control_area: string;
}

let cachedLogoBuffer: Buffer | null | undefined;

function buildPdfBuffer(build: (doc: PDFKit.PDFDocument) => Promise<void>) {
  return new Promise<Buffer>(async (resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 42,
      info: {
        Title: "GWR AI Food Safety Inspection Report"
      }
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      await build(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function ensureSpace(doc: PDFKit.PDFDocument, neededHeight: number) {
  const bottomY = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottomY) {
    doc.addPage();
  }
}

function safeText(value?: string | null) {
  if (!value?.trim()) return "-";
  return value.trim();
}

async function loadLogoBuffer() {
  if (cachedLogoBuffer !== undefined) {
    return cachedLogoBuffer;
  }

  try {
    const logoPath = path.join(process.cwd(), "public", "branding", "gwr-logo.png");
    cachedLogoBuffer = await readFile(logoPath);
    return cachedLogoBuffer;
  } catch {
    cachedLogoBuffer = null;
    return null;
  }
}

function drawHeader(doc: PDFKit.PDFDocument, logoBuffer: Buffer | null) {
  const x = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = 18;

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, x, top, {
        fit: [190, 46]
      });
    } catch {
      // fallback to text-only header if logo render fails
    }
  }

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#111");
  doc.text("GWR Reporting Portal", x, top + 6, { align: "right" });
  doc.font("Helvetica").fontSize(8).fillColor("#555");
  doc.text("AI-assisted inspection report", x, top + 20, { align: "right" });

  doc.moveTo(x, 70).lineTo(right, 70).lineWidth(1).strokeColor("#d7d7d7").stroke();
  doc.fillColor("black");
  doc.y = 80;
}

async function fetchThumbnailBuffer(pathValue: string, timeoutMs = 800) {
  try {
    const { data, error } = await supabaseAdmin.storage
      .from("inspection-images")
      .createSignedUrl(pathValue, 60);

    if (error || !data?.signedUrl) {
      return null;
    }

    const thumbnailUrl = `${data.signedUrl}${data.signedUrl.includes("?") ? "&" : "?"}width=260&height=180&quality=35`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(thumbnailUrl, {
        cache: "no-store",
        signal: controller.signal
      });

      if (!response.ok) {
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

export async function generateInspectionReportPdf(inspectionId: string, userId: string) {
  const { data: inspection } = await supabaseAdmin
    .from("inspections")
    .select("*")
    .eq("id", inspectionId)
    .eq("user_id", userId)
    .single();

  if (!inspection) {
    throw new Error("Inspection not found for report generation.");
  }

  const inspectionRecord = inspection as InspectionRecord;

  if (inspectionRecord.status !== "completed") {
    throw new Error("Inspection is not completed yet.");
  }

  const [sectionsResponse, sectionAssessmentsResponse, findingsResponse] = await Promise.all([
    supabaseAdmin
      .from("inspection_checklist_sections")
      .select("id,section_code,section_title,sort_order")
      .eq("inspection_id", inspectionId)
      .order("sort_order", { ascending: true })
      .limit(16),
    supabaseAdmin
      .from("section_assessments")
      .select("section_code,section_title,compliance_status,score,rationale")
      .eq("inspection_id", inspectionId)
      .limit(60),
    supabaseAdmin
      .from("findings")
      .select(
        "id,section_code,section_title,title,description,severity,confidence,evidence,recommendation,rule_code,rule_title,control_area"
      )
      .eq("inspection_id", inspectionId)
      .order("created_at", { ascending: true })
      .limit(100)
  ]);

  const sections = (sectionsResponse.data ?? []) as ChecklistSectionRecord[];
  const sectionIds = sections.map((section) => section.id);

  const checklistImages: ChecklistImageRecord[] = sectionIds.length
    ? ((
        await supabaseAdmin
          .from("inspection_checklist_images")
          .select("inspection_checklist_section_id,storage_path")
          .in("inspection_checklist_section_id", sectionIds)
          .limit(80)
      ).data ?? [])
    : [];

  const assessments =
    (sectionAssessmentsResponse.data ?? []) as SectionAssessmentRecord[];
  const findings = (findingsResponse.data ?? []) as FindingRecord[];

  const assessmentByCode = new Map(
    assessments.map((assessment) => [assessment.section_code, assessment])
  );

  const findingsBySectionCode = findings.reduce<Map<string, FindingRecord[]>>((acc, finding) => {
    const existing = acc.get(finding.section_code) ?? [];
    existing.push(finding);
    acc.set(finding.section_code, existing);
    return acc;
  }, new Map());

  const primaryImagePathBySectionId = checklistImages.reduce<Map<string, string>>((acc, row) => {
    if (!acc.has(row.inspection_checklist_section_id)) {
      acc.set(row.inspection_checklist_section_id, row.storage_path);
    }
    return acc;
  }, new Map());

  const thumbnailSectionIds = sections
    .map((section) => section.id)
    .filter((sectionId) => Boolean(primaryImagePathBySectionId.get(sectionId)))
    .slice(0, 6);

  const thumbnailBySectionId = new Map<string, Buffer>();
  await Promise.all(
    thumbnailSectionIds.map(async (sectionId) => {
      const pathValue = primaryImagePathBySectionId.get(sectionId);
      if (!pathValue) return;

      const buffer = await fetchThumbnailBuffer(pathValue);
      if (buffer) {
        thumbnailBySectionId.set(sectionId, buffer);
      }
    })
  );

  const logoBuffer = await loadLogoBuffer();

  return buildPdfBuffer(async (doc) => {
    const renderHeader = () => drawHeader(doc, logoBuffer);
    renderHeader();
    doc.on("pageAdded", renderHeader);

    const startedAt = Date.now();
    const budgetMs = 7800;
    const overBudget = () => Date.now() - startedAt > budgetMs;
    let truncated = false;

    doc.font("Helvetica-Bold").fontSize(16).text("Inspection Report");

    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(10);
    doc.text(`Inspection ID: ${inspectionRecord.id}`);
    doc.text(`Date: ${format(new Date(inspectionRecord.created_at), "PPpp")}`);
    doc.text(`Location: ${safeText(inspectionRecord.location)}`);
    doc.text(`Status: ${inspectionRecord.status}`);
    doc.text(`Overall Risk: ${safeText(inspectionRecord.overall_risk)}`);
    doc.text(`Compliance: ${safeText(inspectionRecord.compliance_status)}`);
    doc.text(
      `Compliance Score: ${
        inspectionRecord.compliance_score !== null
          ? inspectionRecord.compliance_score.toFixed(2)
          : "-"
      }`
    );

    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").text("Summary");
    doc.font("Helvetica").text(safeText(inspectionRecord.summary));

    if (inspectionRecord.note?.trim()) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").text("Inspector Note");
      doc.font("Helvetica").text(inspectionRecord.note.trim());
    }

    for (const section of sections) {
      if (overBudget()) {
        truncated = true;
        break;
      }

      ensureSpace(doc, 150);
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(12).text(`Section: ${section.section_title}`);
      doc.font("Helvetica").fontSize(10).text(`Code: ${section.section_code}`);

      const assessment = assessmentByCode.get(section.section_code);
      if (assessment) {
        doc.text(
          `Compliance: ${assessment.compliance_status} | Score: ${assessment.score.toFixed(2)}`
        );
      } else {
        doc.text("Compliance: - | Score: -");
      }

      const thumbnailBuffer = thumbnailBySectionId.get(section.id);
      if (thumbnailBuffer) {
        try {
          const imageTop = doc.y + 4;
          doc.image(thumbnailBuffer, doc.page.margins.left, imageTop, {
            fit: [145, 100]
          });
          doc.y = imageTop + 106;
        } catch {
          doc.text("Thumbnail unavailable.");
        }
      } else {
        doc.text("Thumbnail unavailable.");
      }

      const sectionFindings = (findingsBySectionCode.get(section.section_code) ?? []).slice(0, 5);
      if (sectionFindings.length > 0) {
        doc.font("Helvetica-Bold").text("Findings");
        doc.font("Helvetica");

        for (const finding of sectionFindings) {
          if (overBudget()) {
            truncated = true;
            break;
          }

          ensureSpace(doc, 50);
          doc.font("Helvetica-Bold").text(
            `${finding.title} (${finding.severity}, ${Math.round(finding.confidence * 100)}%)`
          );
          doc.font("Helvetica").text(`Issue: ${finding.description}`);
          doc.text(`Recommendation: ${finding.recommendation}`);
        }
      } else {
        doc.text("No findings recorded.");
      }
    }

    if (truncated) {
      ensureSpace(doc, 65);
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(10).text("Report note");
      doc.font("Helvetica").fontSize(9).text(
        "This PDF was truncated to complete within serverless limits. Full inspection data is available in the portal detail view."
      );
    }

    doc.moveDown(0.5);
    doc.fontSize(9).fillColor("#555");
    doc.text(
      "AI-assisted preliminary findings only. Not a legal determination and not a substitute for official regulator inspection."
    );
    doc.fillColor("black");

    doc.removeListener("pageAdded", renderHeader);
  });
}
