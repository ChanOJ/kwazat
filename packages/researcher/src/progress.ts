/**
 * Approximate progress of a research job, for the progress bar. Sections run one after the
 * other, each taking about as long as its tool budget suggests; the estimate is calibrated on
 * the sections already finished in the same job (a slow day makes the rest slower too).
 */

export type SectionProgress = {
  /** Budget-based duration estimate, in seconds. */
  estimateS: number;
  state: "done" | "running" | "pending";
  /** Running: seconds since it started. Done in this job: how long it took. */
  elapsedS?: number;
};

/** Rough duration of a section from its tool budget (a search or a fetch takes several seconds). */
export const estimateSeconds = (s: { max_searches: number; max_fetches: number }): number =>
  20 + 8 * (s.max_searches + s.max_fetches);

/** Share of the job done, in [0, 99]: never 100 while the job is running. */
export function progressPercent(sections: SectionProgress[]): number {
  if (!sections.length) return 0;
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
    // A running section creeps towards its estimate but never completes by itself.
    else if (s.state === "running") done += Math.min(s.elapsedS ?? 0, expected * 0.95);
  }
  return Math.min(99, Math.floor((100 * done) / total));
}
