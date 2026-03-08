import { Badge } from "@/components/ui/badge";
import type { InspectionStatus } from "@/lib/types/domain";

const statusVariantMap: Record<
  InspectionStatus,
  { label: string; className: string }
> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-700" },
  queued: { label: "Queued", className: "bg-indigo-100 text-indigo-700" },
  processing: { label: "Processing", className: "bg-blue-100 text-blue-700" },
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-700" },
  failed: { label: "Failed", className: "bg-rose-100 text-rose-700" }
};

export function StatusBadge({ status }: { status: InspectionStatus }) {
  const config = statusVariantMap[status] ?? statusVariantMap.draft;
  return <Badge className={config.className}>{config.label}</Badge>;
}
