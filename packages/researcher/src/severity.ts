/**
 * Gravity of a matter (legal case, revelation, controversy), shown as a coloured icon. The
 * research step classifies each item on this objective ladder (see the playbook style); explicit
 * structured fields override it when they contradict the model (a closed or overturned matter is
 * never shown as serious, a final conviction never as minor).
 */
export const SEVERITIES = ["high", "medium", "low", "cleared"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_ICONS: Record<Severity, string> = { high: "🔴", medium: "🟠", low: "🟡", cleared: "◯" };

/** Severity of a fact from its structured data, or null when it has none. */
export function severityOf(data: Record<string, unknown> | null | undefined): Severity | null {
  if (!data) return null;
  if (data.overturned === true || data.procedural_stage === "closed_without_charge") return "cleared";
  if (data.matter_type === "conviction" && data.is_final === true) return "high";
  const claimed = data.severity;
  return typeof claimed === "string" && (SEVERITIES as readonly string[]).includes(claimed) ? (claimed as Severity) : null;
}
