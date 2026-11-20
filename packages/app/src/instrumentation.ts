/**
 * Starts the research worker inside the web server, unless KWAZAT_WORKER=off. On by default in
 * development (one process, as PGlite requires); in production the worker will be its own job,
 * so it only starts there with KWAZAT_WORKER=on.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const setting = process.env.KWAZAT_WORKER ?? (process.env.NODE_ENV === "production" ? "off" : "on");
  if (setting !== "on") return;
  const holder = globalThis as unknown as { kwazatWorker?: boolean };
  if (holder.kwazatWorker) return;
  holder.kwazatWorker = true;
  const { getDb } = await import("./lib/db.ts");
  const { startResearchWorker } = await import("@kwazat/researcher/worker");
  startResearchWorker(await getDb());
}
