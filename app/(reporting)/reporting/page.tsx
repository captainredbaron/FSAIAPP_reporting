import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  averageComplianceScore,
  buildDateTrend,
  buildDistribution,
  buildLocationTrend,
  COMPLIANCE_LABELS,
  RISK_LABELS,
  RISK_ORDER,
  STATUS_LABELS,
  STATUS_ORDER,
  type ReportingInspectionSnapshot
} from "@/lib/reporting/metrics";

const riskBarClass: Record<keyof typeof RISK_LABELS, string> = {
  low: "bg-emerald-500",
  medium: "bg-amber-500",
  high: "bg-orange-500",
  critical: "bg-rose-600"
};

const statusBarClass: Record<keyof typeof STATUS_LABELS, string> = {
  draft: "bg-slate-500",
  queued: "bg-indigo-500",
  processing: "bg-blue-500",
  completed: "bg-emerald-600",
  failed: "bg-rose-600"
};

export default async function ReportingDashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data } = await supabase
    .from("inspections")
    .select("id,status,created_at,location,overall_risk,compliance_status,compliance_score")
    .order("created_at", { ascending: false })
    .limit(3000);

  const inspections = (data ?? []) as ReportingInspectionSnapshot[];

  const totalInspections = inspections.length;
  const averageCompliance = averageComplianceScore(inspections);
  const highOrCriticalRiskCount = inspections.filter(
    (row) => row.overall_risk === "high" || row.overall_risk === "critical"
  ).length;
  const completedCount = inspections.filter((row) => row.status === "completed").length;
  const failedCount = inspections.filter((row) => row.status === "failed").length;

  const riskDistribution = buildDistribution(
    inspections.map((row) => row.overall_risk),
    RISK_ORDER
  );

  const statusDistribution = buildDistribution(
    inspections.map((row) => row.status),
    STATUS_ORDER
  );

  const complianceDistribution = buildDistribution(
    inspections.map((row) => row.compliance_status),
    Object.keys(COMPLIANCE_LABELS) as Array<keyof typeof COMPLIANCE_LABELS>
  );

  const dateTrend = buildDateTrend(inspections, 14);
  const dateTrendMax = Math.max(1, ...dateTrend.map((item) => item.inspections));
  const locationTrend = buildLocationTrend(inspections, 8);
  const locationTrendMax = Math.max(1, ...locationTrend.map((item) => item.inspections), 1);

  if (!inspections.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No inspections yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Reporting data will appear after inspections are submitted from the capture app.
          </p>
          <Button asChild>
            <Link href="/inspections/new">Create First Inspection</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Operations Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Cross-inspection KPI view for quality, risk, and pipeline status.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/reporting/inspections">Open Explorer</Link>
        </Button>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Inspections</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{totalInspections}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Compliance Average</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">
              {averageCompliance !== null ? `${averageCompliance.toFixed(1)}%` : "n/a"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">High/Critical Risk</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{highOrCriticalRiskCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Completed vs Failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-lg font-semibold">{completedCount} completed</p>
            <p className="text-sm text-muted-foreground">{failedCount} failed</p>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Risk Distribution</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {riskDistribution.map((item) => {
              const ratio = totalInspections > 0 ? (item.count / totalInspections) * 100 : 0;
              return (
                <div key={item.key} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{RISK_LABELS[item.key]}</span>
                    <span className="text-muted-foreground">
                      {item.count} ({ratio.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted">
                    <div
                      className={`h-2 rounded-full ${riskBarClass[item.key]}`}
                      style={{ width: `${ratio}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status Distribution</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {statusDistribution.map((item) => {
              const ratio = totalInspections > 0 ? (item.count / totalInspections) * 100 : 0;
              return (
                <div key={item.key} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{STATUS_LABELS[item.key]}</span>
                    <span className="text-muted-foreground">
                      {item.count} ({ratio.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted">
                    <div
                      className={`h-2 rounded-full ${statusBarClass[item.key]}`}
                      style={{ width: `${ratio}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">14-Day Inspection Trend</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {dateTrend.map((item) => (
              <div key={item.key} className="grid grid-cols-[84px_1fr_auto] items-center gap-3">
                <span className="text-xs text-muted-foreground">{item.label}</span>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-primary"
                    style={{ width: `${(item.inspections / dateTrendMax) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {item.inspections}
                  {item.avgCompliance !== null ? ` • ${item.avgCompliance.toFixed(0)}%` : ""}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top Locations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {locationTrend.length > 0 ? (
              locationTrend.map((item) => (
                <div key={item.location} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="truncate pr-3">{item.location}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.inspections} inspections
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted">
                    <div
                      className="h-2 rounded-full bg-accent-foreground"
                      style={{ width: `${(item.inspections / locationTrendMax) * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {item.avgCompliance !== null
                      ? `${item.avgCompliance.toFixed(1)}% avg compliance`
                      : "No compliance score"}{" "}
                    • {item.highRiskCount} high/critical
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No location data available yet.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compliance Status Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3">
          {complianceDistribution.map((item) => (
            <div key={item.key} className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {COMPLIANCE_LABELS[item.key]}
              </p>
              <p className="mt-1 text-2xl font-semibold">{item.count}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
