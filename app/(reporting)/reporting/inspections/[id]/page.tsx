import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { format } from "date-fns";
import { StatusBadge } from "@/components/inspections/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createServerSupabaseClient } from "@/lib/supabase/server";
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
  section_code: string | null;
  section_title: string | null;
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

interface LatestRunRecord {
  model: string;
  error_message: string | null;
  created_at: string;
}

const riskBadgeClass: Record<OverallRisk, string> = {
  low: "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-rose-100 text-rose-700"
};

const complianceBadgeClass: Record<ComplianceStatus, string> = {
  compliant: "bg-emerald-100 text-emerald-700",
  partial_compliant: "bg-amber-100 text-amber-700",
  non_compliant: "bg-rose-100 text-rose-700"
};

const severityBadgeClass: Record<Severity, string> = {
  critical: "bg-rose-100 text-rose-700",
  major: "bg-orange-100 text-orange-700",
  minor: "bg-amber-100 text-amber-700",
  observation: "bg-slate-100 text-slate-700"
};

export default async function ReportingInspectionDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: inspection } = await supabase
    .from("inspections")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!inspection) {
    notFound();
  }

  const [sectionsResponse, assessmentsResponse, findingsResponse, latestRunResponse] =
    await Promise.all([
      supabase
        .from("inspection_checklist_sections")
        .select("id,section_code,section_title,sort_order")
        .eq("inspection_id", id)
        .order("sort_order", { ascending: true }),
      supabase
        .from("section_assessments")
        .select("section_code,section_title,compliance_status,score,rationale")
        .eq("inspection_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("findings")
        .select(
          "id,section_code,section_title,title,description,severity,confidence,evidence,recommendation,rule_code,rule_title,control_area"
        )
        .eq("inspection_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("ai_runs")
        .select("model,error_message,created_at")
        .eq("inspection_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);

  const inspectionRecord = inspection as InspectionRecord;
  const sections = (sectionsResponse.data ?? []) as ChecklistSectionRecord[];
  const assessments = (assessmentsResponse.data ?? []) as SectionAssessmentRecord[];
  const findings = (findingsResponse.data ?? []) as FindingRecord[];
  const latestRun = (latestRunResponse.data ?? null) as LatestRunRecord | null;

  const sectionIds = sections.map((section) => section.id);
  const checklistImages: ChecklistImageRecord[] = sectionIds.length
    ? ((
        await supabase
          .from("inspection_checklist_images")
          .select("inspection_checklist_section_id,storage_path")
          .in("inspection_checklist_section_id", sectionIds)
      ).data ?? [])
    : [];

  const imagesBySection = checklistImages.reduce<Map<string, string[]>>((acc, row) => {
    const existing = acc.get(row.inspection_checklist_section_id) ?? [];
    existing.push(row.storage_path);
    acc.set(row.inspection_checklist_section_id, existing);
    return acc;
  }, new Map());

  const signedBySection = new Map<string, string[]>();
  await Promise.all(
    sections.map(async (section) => {
      const paths = imagesBySection.get(section.id) ?? [];
      if (!paths.length) {
        signedBySection.set(section.id, []);
        return;
      }

      const signed = await Promise.all(
        paths.slice(0, 6).map(async (pathValue) => {
          const { data } = await supabaseAdmin.storage
            .from("inspection-images")
            .createSignedUrl(pathValue, 60 * 30);

          return data?.signedUrl ?? null;
        })
      );

      signedBySection.set(
        section.id,
        signed.filter((value): value is string => Boolean(value))
      );
    })
  );

  const assessmentBySectionCode = new Map(
    assessments.map((assessment) => [assessment.section_code, assessment])
  );

  const findingsBySectionCode = findings.reduce<Map<string, FindingRecord[]>>((acc, finding) => {
    const key = finding.section_code ?? "UNMAPPED";
    const existing = acc.get(key) ?? [];
    existing.push(finding);
    acc.set(key, existing);
    return acc;
  }, new Map());

  return (
    <main className="space-y-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" asChild>
          <Link href="/reporting/inspections">Back to Explorer</Link>
        </Button>
        {inspectionRecord.status === "completed" ? (
          <Button variant="outline" asChild>
            <Link href={`/api/inspections/${inspectionRecord.id}/report`} target="_blank" rel="noreferrer">
              PDF
            </Link>
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">Inspection Detail</CardTitle>
            <StatusBadge status={inspectionRecord.status} />
          </div>
          <p className="text-xs text-muted-foreground">
            Submitted {format(new Date(inspectionRecord.created_at), "PPpp")}
          </p>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <span className="font-medium">Inspection ID:</span> {inspectionRecord.id}
          </p>
          <p>
            <span className="font-medium">Location:</span> {inspectionRecord.location?.trim() || "-"}
          </p>
          <p>
            <span className="font-medium">Note:</span> {inspectionRecord.note?.trim() || "-"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {inspectionRecord.overall_risk ? (
              <Badge className={riskBadgeClass[inspectionRecord.overall_risk]}>
                Risk: {inspectionRecord.overall_risk}
              </Badge>
            ) : null}
            {inspectionRecord.compliance_status ? (
              <Badge className={complianceBadgeClass[inspectionRecord.compliance_status]}>
                Compliance: {inspectionRecord.compliance_status}
              </Badge>
            ) : null}
            {typeof inspectionRecord.compliance_score === "number" ? (
              <Badge variant="outline">
                Score: {inspectionRecord.compliance_score <= 1
                  ? `${(inspectionRecord.compliance_score * 100).toFixed(1)}%`
                  : inspectionRecord.compliance_score.toFixed(1)}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {inspectionRecord.summary?.trim() || "No summary available yet."}
          </p>
        </CardContent>
      </Card>

      {latestRun ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Latest AI Run</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              <span className="font-medium">Model:</span> {latestRun.model}
            </p>
            <p>
              <span className="font-medium">Timestamp:</span>{" "}
              {format(new Date(latestRun.created_at), "PPpp")}
            </p>
            <p>
              <span className="font-medium">Error:</span> {latestRun.error_message || "None"}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-3">
        {sections.length > 0 ? (
          sections.map((section) => {
            const assessment = assessmentBySectionCode.get(section.section_code);
            const sectionFindings = findingsBySectionCode.get(section.section_code) ?? [];
            const urls = signedBySection.get(section.id) ?? [];

            return (
              <Card key={section.id}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{section.section_title}</CardTitle>
                  <p className="text-xs text-muted-foreground">Code: {section.section_code}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {assessment ? (
                    <div className="space-y-1">
                      <Badge className={complianceBadgeClass[assessment.compliance_status]}>
                        {assessment.compliance_status}
                      </Badge>
                      <p className="text-sm text-muted-foreground">{assessment.rationale}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No section assessment available.</p>
                  )}

                  {urls.length ? (
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                      {urls.map((url, index) => (
                        <Image
                          key={`${section.id}-${index}`}
                          src={url}
                          alt={`${section.section_title} photo ${index + 1}`}
                          width={480}
                          height={320}
                          className="h-32 w-full rounded-md object-cover"
                        />
                      ))}
                    </div>
                  ) : null}

                  {sectionFindings.length > 0 ? (
                    <div className="space-y-2">
                      {sectionFindings.map((finding) => (
                        <div key={finding.id} className="rounded-lg border border-border p-3">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <p className="font-medium">{finding.title}</p>
                            <Badge className={severityBadgeClass[finding.severity]}>
                              {finding.severity}
                            </Badge>
                            <Badge variant="outline">
                              {Math.round(finding.confidence * 100)}% confidence
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">{finding.description}</p>
                          <p className="mt-1 text-sm">
                            <span className="font-medium">Evidence:</span> {finding.evidence}
                          </p>
                          <p className="mt-1 text-sm">
                            <span className="font-medium">Recommendation:</span> {finding.recommendation}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {finding.rule_code} - {finding.rule_title} ({finding.control_area})
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No findings for this section.</p>
                  )}
                </CardContent>
              </Card>
            );
          })
        ) : (
          <Card>
            <CardContent className="pt-5 text-sm text-muted-foreground">
              No checklist sections were found for this inspection.
            </CardContent>
          </Card>
        )}
      </section>
    </main>
  );
}
