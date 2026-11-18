/**
 * Domains the Claude web tools cannot reach: many publishers block Anthropic's crawler. Such a
 * domain in `allowed_domains` makes the whole request fail (HTTP 400), and its pages never
 * appear in results anyway. The list is stored in sources/access.json and refreshed with
 * `pnpm reach` (free: the API rejects the request before running any search), and updated
 * automatically when a research request hits the error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ACCESS_FILE = path.resolve(here, "../../../sources/access.json");

export type AccessFile = { checkedAt: string; blocked: string[] };

export function loadAccess(): AccessFile {
  return fs.existsSync(ACCESS_FILE)
    ? (JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8")) as AccessFile)
    : { checkedAt: "never", blocked: [] };
}

function saveAccess(file: AccessFile) {
  fs.writeFileSync(ACCESS_FILE, `${JSON.stringify({ ...file, blocked: [...new Set(file.blocked)].sort() }, null, 1)}\n`);
}

/** Domains listed by the API error "The following domains are not accessible to our user agent". */
export function blockedDomainsFromError(err: unknown): string[] | null {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.match(/domains are not accessible to our user agent: \[([^\]]*)\]/);
  return m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : null;
}

/** Records domains found blocked at runtime (keeps the previous ones). */
export function recordBlocked(domains: string[]) {
  const current = loadAccess();
  saveAccess({ checkedAt: current.checkedAt, blocked: [...current.blocked, ...domains] });
}

/**
 * Checks every registry domain in one request. The API validates `allowed_domains` before any
 * search runs and lists all inaccessible domains in its error, so this costs nothing.
 */
export async function checkAccess(domains: string[]): Promise<AccessFile> {
  const client = new Anthropic();
  let blocked: string[] = [];
  try {
    await client.beta.messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      tool_choice: { type: "none" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1, allowed_domains: domains }],
      messages: [{ role: "user", content: "ok" }],
    });
  } catch (err) {
    const found = blockedDomainsFromError(err);
    if (!found) throw err;
    blocked = found;
  }
  const file = { checkedAt: new Date().toISOString().slice(0, 10), blocked };
  saveAccess(file);
  return file;
}
