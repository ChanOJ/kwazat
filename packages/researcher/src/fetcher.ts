/**
 * WazaBot: downloads public pages to extract facts, within the publishers' stated wishes.
 *
 * Guardrails (see sources/README.md, "Fetching policy"):
 * - identifies itself honestly (never a browser user agent);
 * - obeys robots.txt rules addressed to WazaBot or to every robot;
 * - treats a robots.txt that blocks known AI agents (GPTBot, ClaudeBot, CCBot...) as an
 *   opt-out from AI processing, and so does the TDM reservation protocol (TDMRep) and a refusal
 *   written in plain text recorded in the registry (`ai_opt_out`);
 * - never bypasses a paywall or a login: only what the page serves publicly is read;
 * - keeps nothing of the page beyond the run (only extracted facts, short quotes and the URL).
 * When a page may not be processed, the search engine's title and snippet are used instead.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export const WAZA_BOT_NAME = "WazaBot";
export const WAZA_BOT_UA = "WazaBot/0.1 (+https://github.com/ChanOJ/waza; fact extraction with links back to sources)";

/** User agents of AI crawlers and assistants: blocking them signals an opt-out from AI processing. */
const AI_AGENTS = [
  "gptbot",
  "chatgpt-user",
  "oai-searchbot",
  "claudebot",
  "claude-user",
  "claude-web",
  "claude-searchbot",
  "anthropic-ai",
  "ccbot",
  "google-extended",
  "perplexitybot",
  "perplexity-user",
  "mistralai-user",
  "cohere-ai",
  "applebot-extended",
  "meta-externalagent",
  "bytespider",
];

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3_000_000;
/** About 6,000 tokens of article text per page. */
const MAX_TEXT_CHARS = 24_000;

export type FetchStatus = "fetched" | "snippet_only" | "failed";
export type FetchOutcome = {
  url: string;
  status: FetchStatus;
  /** Why the page was not read in full (opt-out, robots, error...). */
  reason: string | null;
  title: string | null;
  text: string | null;
};

// --- robots.txt (RFC 9309) ------------------------------------------------------------------

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      // An empty Disallow allows everything: no rule needed.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/** Longest matching rule wins; Allow wins ties. No matching rule means allowed. */
function rulesAllow(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!patternMatches(r.pattern, path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) {
      best = r;
    }
  }
  return best ? best.allow : true;
}

/** Rules for one agent: its own groups if any, otherwise the "*" groups. */
function rulesFor(groups: Group[], agent: string, fallbackToStar: boolean): Rule[] | null {
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  if (own.length) return own.flatMap((g) => g.rules);
  if (!fallbackToStar) return null;
  const star = groups.filter((g) => g.agents.includes("*"));
  return star.length ? star.flatMap((g) => g.rules) : null;
}

export function robotsVerdict(groups: Group[], path: string): { allowed: boolean; aiOptOut: string[] } {
  const wazaRules = rulesFor(groups, WAZA_BOT_NAME.toLowerCase(), true);
  const allowed = wazaRules ? rulesAllow(wazaRules, path) : true;
  const aiOptOut = AI_AGENTS.filter((agent) => {
    const rules = rulesFor(groups, agent, false);
    return rules !== null && !rulesAllow(rules, path);
  });
  return { allowed, aiOptOut };
}

// --- TDM reservation protocol (W3C TDMRep) ---------------------------------------------------

type TdmRepEntry = { location: string; "tdm-reservation": number };

function tdmReservedByWellKnown(entries: TdmRepEntry[], path: string): boolean {
  return entries.some((e) => e["tdm-reservation"] === 1 && patternMatches(e.location.replace(/^https?:\/\/[^/]+/, ""), path));
}

// --- Fetching --------------------------------------------------------------------------------

async function get(url: string, accept: string): Promise<Response> {
  return fetch(url, {
    headers: { "User-Agent": WAZA_BOT_UA, Accept: accept, "Accept-Language": "en, fr;q=0.9, *;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export type FetcherOptions = {
  /** Domains with a refusal written in plain text (registry `ai_opt_out`). */
  aiOptOutDomains?: Set<string>;
};

/** Per-run fetcher: caches robots.txt and TDMRep per host. */
export class Fetcher {
  private robots = new Map<string, Promise<Group[] | "unreachable">>();
  private tdmrep = new Map<string, Promise<TdmRepEntry[]>>();

  constructor(private readonly opts: FetcherOptions = {}) {}

  private robotsFor(origin: string) {
    if (!this.robots.has(origin)) {
      this.robots.set(
        origin,
        (async () => {
          try {
            const res = await get(`${origin}/robots.txt`, "text/plain");
            // RFC 9309: a missing file allows everything; a server error means "assume disallowed".
            if (res.status >= 500) return "unreachable" as const;
            return res.ok ? parseRobots(await res.text()) : [];
          } catch {
            return "unreachable" as const;
          }
        })(),
      );
    }
    return this.robots.get(origin)!;
  }

  private tdmrepFor(origin: string) {
    if (!this.tdmrep.has(origin)) {
      this.tdmrep.set(
        origin,
        (async () => {
          try {
            const res = await get(`${origin}/.well-known/tdmrep.json`, "application/json");
            if (!res.ok) return [];
            const json = (await res.json()) as unknown;
            return Array.isArray(json) ? (json as TdmRepEntry[]) : [];
          } catch {
            return [];
          }
        })(),
      );
    }
    return this.tdmrep.get(origin)!;
  }

  /** Why this URL must not be processed by AI, or null if it may be fetched. */
  async policy(url: string): Promise<string | null> {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const optOut = [...(this.opts.aiOptOutDomains ?? [])].find((d) => host === d || host.endsWith(`.${d}`));
    if (optOut) return `publisher refuses AI processing (${optOut}, registry)`;
    const robots = await this.robotsFor(u.origin);
    if (robots === "unreachable") return "robots.txt unreachable";
    const verdict = robotsVerdict(robots, u.pathname + u.search);
    if (!verdict.allowed) return "robots.txt disallows WazaBot";
    if (verdict.aiOptOut.length) return `robots.txt blocks AI agents (${verdict.aiOptOut.slice(0, 3).join(", ")})`;
    if (tdmReservedByWellKnown(await this.tdmrepFor(u.origin), u.pathname)) return "TDM reservation (tdmrep.json)";
    return null;
  }

  async fetch(url: string): Promise<FetchOutcome> {
    const base = { url, title: null, text: null };
    try {
      const refused = await this.policy(url);
      if (refused) return { ...base, status: "snippet_only", reason: refused };

      const res = await get(url, "text/html,application/xhtml+xml");
      if (!res.ok) return { ...base, status: "failed", reason: `HTTP ${res.status}` };
      if (res.headers.get("tdm-reservation") === "1") {
        await res.body?.cancel();
        return { ...base, status: "snippet_only", reason: "TDM reservation (HTTP header)" };
      }
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("html")) {
        await res.body?.cancel();
        return { ...base, status: "snippet_only", reason: `unsupported content type (${type.split(";")[0]})` };
      }
      const html = await readLimited(res);
      const { document } = parseHTML(html);
      const meta = document.querySelector('meta[name="tdm-reservation"]')?.getAttribute("content");
      if (meta === "1") return { ...base, status: "snippet_only", reason: "TDM reservation (meta tag)" };

      const article = new Readability(document as unknown as Document).parse();
      const text = (article?.textContent ?? document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length < 200) return { ...base, status: "snippet_only", reason: "no readable public text (paywall or script-only page)" };
      return { url, status: "fetched", reason: null, title: article?.title ?? null, text: text.slice(0, MAX_TEXT_CHARS) };
    } catch (err) {
      return { ...base, status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
