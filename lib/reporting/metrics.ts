import { format, subDays } from "date-fns";
import type {
  ComplianceStatus,
  InspectionStatus,
  OverallRisk
} from "@/lib/types/domain";

export interface ReportingInspectionSnapshot {
  id: string;
  status: InspectionStatus;
  created_at: string;
  location: string | null;
  overall_risk: OverallRisk | null;
  compliance_status: ComplianceStatus | null;
  compliance_score: number | null;
}

export const STATUS_ORDER: InspectionStatus[] = [
  "draft",
  "queued",
  "processing",
  "completed",
  "failed"
];

export const RISK_ORDER: OverallRisk[] = ["low", "medium", "high", "critical"];

export const COMPLIANCE_ORDER: ComplianceStatus[] = [
  "compliant",
  "partial_compliant",
  "non_compliant"
];

export const STATUS_LABELS: Record<InspectionStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed"
};

export const RISK_LABELS: Record<OverallRisk, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical"
};

export const COMPLIANCE_LABELS: Record<ComplianceStatus, string> = {
  compliant: "Compliant",
  partial_compliant: "Partial Compliant",
  non_compliant: "Non Compliant"
};

export function buildDistribution<T extends string>(
  values: Array<T | null | undefined>,
  order: T[]
) {
  const counts = new Map<T, number>(order.map((item) => [item, 0]));

  for (const value of values) {
    if (!value || !counts.has(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return order.map((item) => ({
    key: item,
    count: counts.get(item) ?? 0
  }));
}

export function normalizeComplianceScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return value <= 1 ? value * 100 : value;
}

export function averageComplianceScore(rows: ReportingInspectionSnapshot[]) {
  const values = rows
    .map((row) => row.compliance_score)
    .filter((value): value is number => typeof value === "number");

  if (values.length === 0) {
    return null;
  }

  const average = values.reduce((sum, value) => sum + normalizeComplianceScore(value), 0) / values.length;
  return average;
}

interface TrendBucket {
  inspections: number;
  complianceTotal: number;
  complianceCount: number;
}

export function buildDateTrend(rows: ReportingInspectionSnapshot[], days = 14) {
  const now = new Date();
  const dateKeys = Array.from({ length: days }, (_unused, index) => {
    const date = subDays(now, days - index - 1);
    return format(date, "yyyy-MM-dd");
  });

  const buckets = new Map<string, TrendBucket>(
    dateKeys.map((key) => [
      key,
      { inspections: 0, complianceTotal: 0, complianceCount: 0 }
    ])
  );

  for (const row of rows) {
    const key = format(new Date(row.created_at), "yyyy-MM-dd");
    const bucket = buckets.get(key);
    if (!bucket) continue;

    bucket.inspections += 1;
    if (typeof row.compliance_score === "number") {
      bucket.complianceTotal += normalizeComplianceScore(row.compliance_score);
      bucket.complianceCount += 1;
    }
  }

  return dateKeys.map((key) => {
    const bucket = buckets.get(key)!;
    return {
      key,
      label: format(new Date(`${key}T00:00:00Z`), "MMM d"),
      inspections: bucket.inspections,
      avgCompliance:
        bucket.complianceCount > 0 ? bucket.complianceTotal / bucket.complianceCount : null
    };
  });
}

function normalizeLocation(value: string | null) {
  if (!value?.trim()) return "Unspecified";
  return value.trim().replace(/\s+/g, " ");
}

export function buildLocationTrend(rows: ReportingInspectionSnapshot[], limit = 8) {
  const buckets = new Map<
    string,
    {
      inspections: number;
      complianceTotal: number;
      complianceCount: number;
      highRiskCount: number;
    }
  >();

  for (const row of rows) {
    const key = normalizeLocation(row.location);
    const bucket = buckets.get(key) ?? {
      inspections: 0,
      complianceTotal: 0,
      complianceCount: 0,
      highRiskCount: 0
    };

    bucket.inspections += 1;
    if (typeof row.compliance_score === "number") {
      bucket.complianceTotal += normalizeComplianceScore(row.compliance_score);
      bucket.complianceCount += 1;
    }
    if (row.overall_risk === "high" || row.overall_risk === "critical") {
      bucket.highRiskCount += 1;
    }

    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([location, bucket]) => ({
      location,
      inspections: bucket.inspections,
      avgCompliance:
        bucket.complianceCount > 0 ? bucket.complianceTotal / bucket.complianceCount : null,
      highRiskCount: bucket.highRiskCount
    }))
    .sort((a, b) => b.inspections - a.inspections)
    .slice(0, limit);
}
