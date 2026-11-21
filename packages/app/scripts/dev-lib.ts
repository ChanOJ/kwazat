/**
 * Local development plumbing shared by the dev launcher, the proxy and the seed: topic name,
 * free port, and the registry of running dev servers (one small JSON file per topic).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The worktree (or checkout) this code runs from. */
export const repoRoot = path.resolve(import.meta.dirname, "../../..");
/** Per-worktree data: PGlite database, mailbox, test account password. Gitignored. */
export const dataDir = path.join(repoRoot, ".data");

/** Fixed port of the shared reverse proxy (dev servers themselves get a random port 3000 to 3999). */
export const PROXY_PORT = Number(process.env.KWAZAT_PROXY_PORT) || 4000;
export const DOMAIN = "kwazat.localhost";
/** Shared by every worktree of the machine; override for tests. */
export const homeDir = process.env.KWAZAT_DEV_HOME || path.join(os.homedir(), ".kwazat-dev");
export const routesDir = path.join(homeDir, "routes");

export type Route = { topic: string; port: number; pid: number; root: string };

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** Topic of this worktree: KWAZAT_TOPIC, else the branch name without its `claude/` prefix, else the folder name. */
export function topicName(): string {
  const fromEnv = process.env.KWAZAT_TOPIC && slug(process.env.KWAZAT_TOPIC);
  if (fromEnv) return fromEnv;
  let branch = "";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // not a git checkout
  }
  const name = slug(branch.replace(/^claude\//, "")) || slug(path.basename(repoRoot));
  return name || "dev";
}

export const urlFor = (topic: string) => `http://${topic}.${DOMAIN}:${PROXY_PORT}`;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Topics come from branch names and, in the proxy, from the Host header: only a plain DNS label becomes a file name. */
const routeFile = (topic: string) => {
  const name = path.basename(topic.replace(/[^a-z0-9-]/g, ""));
  if (name === "" || name !== topic) throw new Error("Invalid topic");
  return path.join(routesDir, `${name}.json`);
};

/** The live route of a topic. A route whose process is gone is stale: it is deleted and ignored. */
export function readRoute(topic: string): Route | null {
  if (!/^[a-z0-9-]{1,63}$/.test(topic)) return null;
  const file = routeFile(topic);
  try {
    const route = JSON.parse(fs.readFileSync(file, "utf8")) as Route;
    if (Number.isInteger(route.port) && Number.isInteger(route.pid) && alive(route.pid)) return route;
  } catch {
    // missing or unreadable: same as no route
  }
  fs.rmSync(file, { force: true });
  return null;
}

export function liveRoutes(): Route[] {
  if (!fs.existsSync(routesDir)) return [];
  return fs
    .readdirSync(routesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readRoute(f.slice(0, -5)))
    .filter((r): r is Route => r !== null)
    .sort((a, b) => a.topic.localeCompare(b.topic));
}

export function writeRoute(route: Route): void {
  fs.mkdirSync(routesDir, { recursive: true });
  const tmp = `${routeFile(route.topic)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(route));
  fs.renameSync(tmp, routeFile(route.topic)); // atomic: the proxy never reads half a file
}

export function removeRoute(topic: string, pid: number): void {
  const current = readRouteRaw(topic);
  if (current?.pid === pid) fs.rmSync(routeFile(topic), { force: true });
}

function readRouteRaw(topic: string): Route | null {
  try {
    return JSON.parse(fs.readFileSync(routeFile(topic), "utf8")) as Route;
  } catch {
    return null;
  }
}

function listening(port: number): boolean {
  try {
    execFileSync("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
    return true;
  } catch {
    return false; // lsof exits 1 when nothing listens
  }
}

/** A random free port between 3000 and 3999, also not announced by another dev server. */
export function pickPort(): number {
  const taken = new Set(liveRoutes().map((r) => r.port));
  for (let i = 0; i < 200; i++) {
    const port = 3000 + Math.floor(Math.random() * 1000);
    if (!taken.has(port) && !listening(port)) return port;
  }
  throw new Error("No free port between 3000 and 3999");
}

/** Is a dev server of this worktree running (it holds the PGlite directory)? */
export const devServerRunning = (): boolean => readRoute(topicName())?.root === repoRoot;
