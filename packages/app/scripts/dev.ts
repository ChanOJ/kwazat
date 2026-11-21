/**
 * `pnpm app`: starts this worktree's dev server at http://<topic>.kwazat.localhost:4000.
 * Database and accounts are prepared first (PGlite allows one process, so before the server
 * opens it), then the shared proxy is started if needed, the route registered, and Next runs
 * on a random free port.
 *
 *   pnpm app                       topic from the branch name
 *   KWAZAT_TOPIC=demo pnpm app     explicit topic
 *   pnpm app:reset                 recreate the database (see scripts/reset.ts)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { homeDir, liveRoutes, pickPort, PROXY_PORT, readRoute, removeRoute, repoRoot, topicName, urlFor, writeRoute } from "./dev-lib.ts";
import { prepareDatabase } from "./seed.ts";

function proxyUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(PROXY_PORT, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}

async function ensureProxy(): Promise<void> {
  if (await proxyUp()) return;
  fs.mkdirSync(homeDir, { recursive: true });
  const log = fs.openSync(path.join(homeDir, "proxy.log"), "a");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "dev-proxy.ts")], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await proxyUp()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The dev proxy did not start on port ${PROXY_PORT} (see ${path.join(homeDir, "proxy.log")})`);
}

const topic = topicName();
const existing = readRoute(topic);
if (existing) {
  console.error(`Topic "${topic}" is already served by ${existing.root} (pid ${existing.pid}).\nStop it, or pick another name: KWAZAT_TOPIC=other pnpm app`);
  process.exit(1);
}

await prepareDatabase();
await ensureProxy();

const port = Number(process.env.PORT) || pickPort();
const url = urlFor(topic);
const child = spawn("next", ["dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: path.join(repoRoot, "packages/app"),
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || url, KWAZAT_TOPIC: topic },
});
writeRoute({ topic, port, pid: process.pid, root: repoRoot });
console.log(`\n  ${topic}: ${url}  (Next on 127.0.0.1:${port})\n  also running: ${liveRoutes().map((r) => r.topic).join(", ")}\n`);

const stop = () => removeRoute(topic, process.pid);
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => {
  stop();
  process.exit(code ?? 0);
});
