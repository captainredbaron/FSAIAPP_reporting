export type InspectionStatus =
  | "draft"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export type Severity = "critical" | "major" | "minor" | "observation";

export type OverallRisk = "low" | "medium" | "high" | "critical";
export type ComplianceStatus = "compliant" | "partial_compliant" | "non_compliant";

export interface InspectionSummary {
  overall_risk: OverallRisk;
  summary: string;
}

export interface Finding {
  title: string;
  description: string;
  severity: Severity;
  confidence: number;
  evidence: string;
  recommendation: string;
  rule_code: string;
  rule_title: string;
  control_area: string;
  section_code: string;
  section_title: string;
}

export interface SectionAssessment {
  section_code: string;
  section_title: string;
  compliance_status: ComplianceStatus;
  score: number;
  rationale: string;
}

export interface AiInspectionResult {
  inspection_summary: InspectionSummary;
  section_assessments: SectionAssessment[];
  findings: Finding[];
  unclassified_observations: string[];
}

export interface RuleLibraryItem {
  id: string;
  rule_code: string;
  rule_title: string;
  control_area: string;
  short_requirement: string;
  severity_default: Severity;
  active: boolean;
}

export interface ChecklistSectionDefinition {
  id: string;
  section_code: string;
  section_title: string;
  control_area: string | null;
  description: string | null;
  sort_order: number;
  active: boolean;
}
