import { readFile } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { NextResponse } from "next/server";
import { format } from "date-fns";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ComplianceStatus, OverallRisk, Severity } from "@/lib/types/domain";

export const runtime = "nodejs";
export const maxDuration = 120;

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
  completed_at: string | null;
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
      // Fallback to text-only header when image embedding fails.
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

async function fetchImageBuffer(pathValue: string, timeoutMs = 2500) {
  try {
    const { data, error } = await supabaseAdmin.storage
      .from("inspection-images")
      .createSignedUrl(pathValue, 60);

    if (error || !data?.signedUrl) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(data.signedUrl, {
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

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const includePhotos = new URL(request.url).searchParams.get("include_photos") === "1";

  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: inspection } = await supabase
    .from("inspections")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!inspection) {
    return NextResponse.json({ error: "Inspection not found." }, { status: 404 });
  }

  const inspectionRecord = inspection as InspectionRecord;

  if (inspectionRecord.status !== "completed") {
    return NextResponse.json(
      { error: "PDF report is available only after analysis is completed." },
      { status: 400 }
    );
  }

  const [sectionsResponse, sectionAssessmentsResponse, findingsResponse] = await Promise.all([
    supabase
      .from("inspection_checklist_sections")
      .select("id,section_code,section_title,sort_order")
      .eq("inspection_id", id)
      .order("sort_order", { ascending: true }),
    supabase
      .from("section_assessments")
      .select("section_code,section_title,compliance_status,score,rationale")
      .eq("inspection_id", id),
    supabase
      .from("findings")
      .select(
        "id,section_code,section_title,title,description,severity,confidence,evidence,recommendation,rule_code,rule_title,control_area"
      )
      .eq("inspection_id", id)
      .order("created_at", { ascending: true })
  ]);

  const sections = (sectionsResponse.data ?? []) as ChecklistSectionRecord[];
  const sectionIds = sections.map((section) => section.id);

  const { data: imageData } = sectionIds.length
    ? await supabase
        .from("inspection_checklist_images")
        .select("inspection_checklist_section_id,storage_path")
        .in("inspection_checklist_section_id", sectionIds)
    : { data: [] as ChecklistImageRecord[] };

  const checklistImages = (imageData ?? []) as ChecklistImageRecord[];
  const assessments =
    (sectionAssessmentsResponse.data ?? []) as SectionAssessmentRecord[];
  const findings = (findingsResponse.data ?? []) as FindingRecord[];

  const assessmentByCode = new Map(
    assessments.map((assessment) => [assessment.section_code, assessment])
  );

  const imagesBySectionId = checklistImages.reduce<Map<string, string[]>>((acc, row) => {
    const existing = acc.get(row.inspection_checklist_section_id) ?? [];
    existing.push(row.storage_path);
    acc.set(row.inspection_checklist_section_id, existing);
    return acc;
  }, new Map());

  const findingsBySectionCode = findings.reduce<Map<string, FindingRecord[]>>((acc, finding) => {
    const existing = acc.get(finding.section_code) ?? [];
    existing.push(finding);
    acc.set(finding.section_code, existing);
    return acc;
  }, new Map());

  const logoBuffer = await loadLogoBuffer();

  const pdfBuffer = await buildPdfBuffer(async (doc) => {
    const renderHeader = () => drawHeader(doc, logoBuffer);
    renderHeader();
    doc.on("pageAdded", renderHeader);

    let embeddedPhotos = 0;
    const maxEmbeddedPhotos = 8;

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

    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text("Summary");
    doc.font("Helvetica").text(safeText(inspectionRecord.summary));

    if (inspectionRecord.note?.trim()) {
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").text("Inspector Note");
      doc.font("Helvetica").text(inspectionRecord.note.trim());
    }

    doc.moveDown(0.6);
    doc.fontSize(9).fillColor("#555");
    doc.text(
      "AI-assisted preliminary findings only. Not a legal determination and not a substitute for official regulator inspection."
    );
    doc.fillColor("black");

    for (const section of sections) {
      ensureSpace(doc, 120);
      doc.moveDown(0.9);
      doc.font("Helvetica-Bold").fontSize(13).text(`Section: ${section.section_title}`);
      doc.font("Helvetica").fontSize(10).text(`Code: ${section.section_code}`);

      const assessment = assessmentByCode.get(section.section_code);
      if (assessment) {
        doc.text(
          `Compliance: ${assessment.compliance_status} | Score: ${assessment.score.toFixed(2)}`
        );
        doc.text(`Section Analysis: ${assessment.rationale}`);
      } else {
        doc.text("Compliance: - | Score: -");
        doc.text("Section Analysis: Not available.");
      }

      const sectionFindings = findingsBySectionCode.get(section.section_code) ?? [];
      if (sectionFindings.length > 0) {
        doc.moveDown(0.3);
        doc.font("Helvetica-Bold").text("Findings and Rectification");
        doc.font("Helvetica");

        for (const finding of sectionFindings) {
          ensureSpace(doc, 90);
          doc.moveDown(0.2);
          doc.font("Helvetica-Bold").text(
            `${finding.title} (${finding.severity}, confidence ${Math.round(
              finding.confidence * 100
            )}%)`
          );
          doc.font("Helvetica").text(`Issue: ${finding.description}`);
          doc.text(`Evidence: ${finding.evidence}`);
          doc.text(`Rectification: ${finding.recommendation}`);
          doc.text(
            `Rule Reference: ${finding.rule_code} - ${finding.rule_title} (${finding.control_area})`
          );
        }
      } else {
        doc.moveDown(0.3);
        doc.text("No structured findings recorded for this section.");
      }

      const paths = imagesBySectionId.get(section.id) ?? [];
      if (paths.length > 0) {
        doc.moveDown(0.4);
        doc.font("Helvetica-Bold").text("Section Photos");
        doc.font("Helvetica");

        if (!includePhotos) {
          doc.text(
            `Photos omitted in fast export (${paths.length} available). Add ?include_photos=1 to include limited previews.`
          );
          continue;
        }

        const previewPaths = paths.slice(0, 1);

        for (const pathValue of previewPaths) {
          if (embeddedPhotos >= maxEmbeddedPhotos) {
            doc.text("Photo preview limit reached for this report.");
            break;
          }

          ensureSpace(doc, 210);
          const imageBuffer = await fetchImageBuffer(pathValue);

          if (!imageBuffer) {
            doc.text(`Image unavailable: ${pathValue}`);
            continue;
          }

          try {
            const imageTop = doc.y + 4;
            doc.image(imageBuffer, doc.page.margins.left, imageTop, {
              fit: [250, 180]
            });
            doc.y = imageTop + 188;
            embeddedPhotos += 1;
          } catch {
            doc.text(`Unsupported image format for embedding: ${pathValue}`);
          }
        }

        if (paths.length > previewPaths.length) {
          doc.text(`${paths.length - previewPaths.length} additional photos not embedded.`);
        }
      } else {
        doc.moveDown(0.3);
        doc.text("No photos recorded for this section.");
      }
    }

    doc.removeListener("pageAdded", renderHeader);
  });

  const filename = `inspection-report-${inspectionRecord.id}.pdf`;

  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store"
    }
  });
}
