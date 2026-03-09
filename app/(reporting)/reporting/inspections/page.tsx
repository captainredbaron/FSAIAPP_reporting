import Link from "next/link";
import { format } from "date-fns";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/inspections/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  COMPLIANCE_LABELS,
  COMPLIANCE_ORDER,
  RISK_LABELS,
  RISK_ORDER,
  STATUS_LABELS,
  STATUS_ORDER,
  type ReportingInspectionSnapshot
} from "@/lib/reporting/metrics";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ComplianceStatus, OverallRisk } from "@/lib/types/domain";

type SearchParams = Record<string, string | string[] | undefined>;

interface ExplorerPageProps {
  searchParams?: Promise<SearchParams>;
}

interface FindingReferenceRow {
  inspection_id: string;
}

const complianceBadgeClass: Record<ComplianceStatus, string> = {
  compliant: "bg-emerald-100 text-emerald-700",
  partial_compliant: "bg-amber-100 text-amber-700",
  non_compliant: "bg-rose-100 text-rose-700"
};

const riskBadgeClass: Record<OverallRisk, string> = {
  low: "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-rose-100 text-rose-700"
};

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseDateInput(value: string | undefined) {
  if (!value) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function parseEnumValue<T extends string>(
  value: string | undefined,
  allowedValues: readonly T[]
): T | "" {
  if (!value) return "";
  return allowedValues.includes(value as T) ? (value as T) : "";
}

function normalizeSectionRuleQuery(value: string | undefined) {
  if (!value) return "";
  return value.trim().replace(/[%]/g, "").replace(/,/g, " ").replace(/['"]/g, "");
}

function toPercent(value: number) {
  return value <= 1 ? value * 100 : value;
}

export default async function ReportingExplorerPage({
  searchParams
}: ExplorerPageProps) {
  const params = (await searchParams) ?? {};

  const fromDate = parseDateInput(firstValue(params.from));
  const toDate = parseDateInput(firstValue(params.to));
  const locationFilter = firstValue(params.location)?.trim() ?? "";
  const statusFilter = parseEnumValue(firstValue(params.status), STATUS_ORDER);
  const riskFilter = parseEnumValue(firstValue(params.risk), RISK_ORDER);
  const complianceFilter = parseEnumValue(
    firstValue(params.compliance_status),
    COMPLIANCE_ORDER
  );
  const sectionRuleQuery = normalizeSectionRuleQuery(firstValue(params.section_rule));

  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  let matchingInspectionIds: string[] | null = null;
  if (sectionRuleQuery) {
    const { data: findingMatches } = await supabase
      .from("findings")
      .select("inspection_id")
      .or(
        `rule_code.ilike.%${sectionRuleQuery}%,rule_title.ilike.%${sectionRuleQuery}%,section_code.ilike.%${sectionRuleQuery}%,section_title.ilike.%${sectionRuleQuery}%`
      )
      .limit(5000);

    matchingInspectionIds = [...new Set((findingMatches ?? []).map((row) => row.inspection_id))];
  }

  let inspections: ReportingInspectionSnapshot[] = [];
  let totalCount = 0;

  if (matchingInspectionIds !== null && matchingInspectionIds.length === 0) {
    inspections = [];
    totalCount = 0;
  } else {
    let query = supabase
      .from("inspections")
      .select(
        "id,status,created_at,location,overall_risk,compliance_status,compliance_score",
        {
          count: "exact"
        }
      )
      .eq("user_id", user.id);

    if (fromDate) {
      query = query.gte("created_at", `${fromDate}T00:00:00.000Z`);
    }
    if (toDate) {
      query = query.lte("created_at", `${toDate}T23:59:59.999Z`);
    }
    if (locationFilter) {
      query = query.ilike("location", `%${locationFilter}%`);
    }
    if (statusFilter) {
      query = query.eq("status", statusFilter);
    }
    if (riskFilter) {
      query = query.eq("overall_risk", riskFilter);
    }
    if (complianceFilter) {
      query = query.eq("compliance_status", complianceFilter);
    }
    if (matchingInspectionIds && matchingInspectionIds.length > 0) {
      query = query.in("id", matchingInspectionIds);
    }

    const { data, count } = await query
      .order("created_at", { ascending: false })
      .limit(200);

    inspections = (data ?? []) as ReportingInspectionSnapshot[];
    totalCount = count ?? inspections.length;
  }

  const inspectionIds = inspections.map((inspection) => inspection.id);

  let findingReferences: FindingReferenceRow[] = [];
  if (inspectionIds.length > 0) {
    const { data } = await supabase
      .from("findings")
      .select("inspection_id")
      .in("inspection_id", inspectionIds);
    findingReferences = (data ?? []) as FindingReferenceRow[];
  }

  const findingsCountByInspection = findingReferences.reduce<Map<string, number>>((acc, row) => {
    acc.set(row.inspection_id, (acc.get(row.inspection_id) ?? 0) + 1);
    return acc;
  }, new Map());

  const { data: locationsData } = await supabase
    .from("inspections")
    .select("location")
    .eq("user_id", user.id)
    .not("location", "is", null)
    .order("location", { ascending: true })
    .limit(400);

  const locationOptions = [...new Set((locationsData ?? []).map((row) => row.location?.trim() ?? ""))]
    .filter(Boolean)
    .slice(0, 80);

  return (
    <div className="space-y-5 pb-8">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Inspections Explorer</h2>
          <p className="text-sm text-muted-foreground">
            Filtered inspection table for operations review and PDF access.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/reporting">Back to Dashboard</Link>
        </Button>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" action="/reporting/inspections" className="grid gap-4 lg:grid-cols-3 2xl:grid-cols-7">
            <div className="space-y-1.5">
              <Label htmlFor="from">From</Label>
              <Input id="from" name="from" type="date" defaultValue={fromDate} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="to">To</Label>
              <Input id="to" name="to" type="date" defaultValue={toDate} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="location">Location</Label>
              <Input
                id="location"
                name="location"
                list="location-options"
                defaultValue={locationFilter}
                placeholder="Any location"
              />
              <datalist id="location-options">
                {locationOptions.map((location) => (
                  <option key={location} value={location} />
                ))}
              </datalist>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                name="status"
                defaultValue={statusFilter}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All statuses</option>
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="risk">Risk</Label>
              <select
                id="risk"
                name="risk"
                defaultValue={riskFilter}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All risk levels</option>
                {RISK_ORDER.map((risk) => (
                  <option key={risk} value={risk}>
                    {RISK_LABELS[risk]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="compliance_status">Compliance</Label>
              <select
                id="compliance_status"
                name="compliance_status"
                defaultValue={complianceFilter}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All compliance</option>
                {COMPLIANCE_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {COMPLIANCE_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="section_rule">Section/Rule</Label>
              <Input
                id="section_rule"
                name="section_rule"
                defaultValue={sectionRuleQuery}
                placeholder="e.g. SANITIZATION or FCS-101"
              />
            </div>

            <div className="flex items-end gap-2 lg:col-span-3 2xl:col-span-7">
              <Button type="submit">Apply Filters</Button>
              <Button variant="outline" asChild>
                <Link href="/reporting/inspections">Clear</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Results</CardTitle>
          <p className="text-sm text-muted-foreground">
            Showing {inspections.length} of {totalCount} matched inspections (max 200 rows shown).
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="min-w-[1120px] text-left text-sm">
              <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-3">Date</th>
                  <th className="px-3 py-3">Location</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Risk</th>
                  <th className="px-3 py-3">Compliance</th>
                  <th className="px-3 py-3">Findings</th>
                  <th className="px-3 py-3">Inspection</th>
                  <th className="px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inspections.length > 0 ? (
                  inspections.map((inspection) => {
                    const findingsCount = findingsCountByInspection.get(inspection.id) ?? 0;

                    return (
                      <tr key={inspection.id} className="border-t border-border align-top">
                        <td className="px-3 py-3 text-xs text-muted-foreground">
                          {format(new Date(inspection.created_at), "PP p")}
                        </td>
                        <td className="max-w-[200px] px-3 py-3">
                          <span className="break-words text-muted-foreground">
                            {inspection.location?.trim() || "-"}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <StatusBadge status={inspection.status} />
                        </td>
                        <td className="px-3 py-3">
                          {inspection.overall_risk ? (
                            <Badge className={riskBadgeClass[inspection.overall_risk]}>
                              {RISK_LABELS[inspection.overall_risk]}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">n/a</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {inspection.compliance_status ? (
                            <div className="space-y-1">
                              <Badge className={complianceBadgeClass[inspection.compliance_status]}>
                                {COMPLIANCE_LABELS[inspection.compliance_status]}
                              </Badge>
                              <p className="text-xs text-muted-foreground">
                                {typeof inspection.compliance_score === "number"
                                  ? `${toPercent(inspection.compliance_score).toFixed(1)}%`
                                  : "n/a"}
                              </p>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">n/a</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-foreground">{findingsCount}</td>
                        <td className="px-3 py-3 text-xs">
                          <Link
                            href={`/reporting/inspections/${inspection.id}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {inspection.id}
                          </Link>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" asChild>
                              <Link href={`/reporting/inspections/${inspection.id}`}>Open</Link>
                            </Button>
                            {inspection.status === "completed" ? (
                              <Button size="sm" variant="outline" asChild>
                                <Link
                                  href={`/api/inspections/${inspection.id}/report`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  PDF
                                </Link>
                              </Button>
                            ) : (
                              <span className="pt-2 text-xs text-muted-foreground">PDF pending</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      No inspections found for the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
