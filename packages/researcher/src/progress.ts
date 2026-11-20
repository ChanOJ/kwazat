/**
 * Approximate progress of a research job, for the progress bar. Sections run one after the
 * other. A section's duration is estimated from the recorded durations of the previous runs of
 * the same section of the same playbook, whatever their version (playbooks change often, so
 * the history of earlier versions is the best guide); without history, from its tool budget.
 * The estimate is then calibrated on the sections already finished in the same job (a slow day
 * makes the rest slower too).
 */

export type SectionProgress = {
  /** Budget-based duration estimate, in seconds. */
  estimateS: number;
  state: "done" | "running" | "pending";
  /** Running: seconds since it started. Done in this job: how long it took. */
  elapsedS?: number;
};

/**
 * Duration of a section without history, from its tool budget. Calibrated on measured runs
 * (about 5 minutes for 11 tool calls on a band).
 */
export const estimateSeconds = (s: { max_searches: number; max_fetches: number }): number =>
  30 + 25 * (s.max_searches + s.max_fetches);

/** Median of durations (robust to the odd very slow or very fast run); null when there are none. */
export function medianSeconds(durations: number[]): number | null {
  if (!durations.length) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Share of its estimate a running section is considered done: linear up to 80 %, then slowing
 * towards 97 % so that a section running longer than usual keeps moving without ever finishing.
 */
export function runningShare(elapsedS: number, expectedS: number): number {
  const x = elapsedS / expectedS;
  return x <= 0.8 ? x : 0.8 + 0.17 * (1 - Math.exp(-(x - 0.8) / 0.5));
}

/** Share of the job done, in [0, 99] (never 100 while the job is running), and time left. */
export function progressEstimate(sections: SectionProgress[]): { percent: number; remainingS: number } {
  if (!sections.length) return { percent: 0, remainingS: 0 };
  const measured = sections.filter((s) => s.state === "done" && s.elapsedS !== undefined);
  const estimated = measured.reduce((n, s) => n + s.estimateS, 0);
  const actual = measured.reduce((n, s) => n + (s.elapsedS ?? 0), 0);
  const speed = estimated > 0 ? Math.min(3, Math.max(0.3, actual / estimated)) : 1;
  let total = 0;
  let done = 0;
  for (const s of sections) {
    const expected = s.estimateS * (s.state === "done" && s.elapsedS === undefined ? 1 : speed);
    total += expected;
    if (s.state === "done") done += expected;
    // A running section moves towards its estimate but never completes by itself.
    else if (s.state === "running") done += expected * runningShare(s.elapsedS ?? 0, expected);
  }
  return { percent: Math.min(99, Math.floor((100 * done) / total)), remainingS: Math.max(0, Math.round(total - done)) };
}

/** Share of the job done, in [0, 99]. */
export const progressPercent = (sections: SectionProgress[]): number => progressEstimate(sections).percent;
