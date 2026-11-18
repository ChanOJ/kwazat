/**
 * trust.txt (JournalList, https://journallist.net): a plain-text file in which a news publisher
 * declares who controls it, which associations it belongs to, its official contacts and, since
 * 2024, whether its content may be used for AI training (`datatrainingallowed`).
 *
 * A declaration is a claim, not a proof: a link counts as confirmed only when the other side
 * declares it too (`belongto=` ↔ `member=`, `controlledby=` ↔ `control=`).
 *
 * `pnpm trust` stores the declarations of every registry domain, plus the associations and
 * owners they point to, in sources/trust.json, and reports ownership and affiliations to check
 * against the registry. They do not change any tier (see sources/README.md).
 *
 * `datatrainingallowed` is recorded for information only: it is about training models, which
 * Kwazat does not do, so it neither allows nor forbids reading a page (see fetcher.ts for the
 * signals that do).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { botGet } from "./fetcher.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TRUST_FILE = path.resolve(here, "../../../sources/trust.json");

/** Variables of the specification whose value is a URL, kept as declared. */
const LINK_KEYS = ["belongto", "member", "control", "controlledby", "social", "contact", "vendor", "customer"] as const;
type LinkKey = (typeof LINK_KEYS)[number];

export type TrustDeclarations = Record<LinkKey, string[]> & {
  /** null when the file says nothing about it. */
  datatrainingallowed: boolean | null;
};

export type TrustRecord = TrustDeclarations & { url: string };

export type TrustSnapshot = {
  checkedAt: string;
  /** Domains whose trust.txt was found, with what it declares. */
  files: Record<string, TrustRecord>;
  /** Domains checked without finding a valid trust.txt. */
  missing: string[];
};

/**
 * Strict parser: `key=value` lines, `#` comments. Returns null for anything that is not a
 * trust.txt (an HTML error page served with status 200, an empty file, unknown keys only).
 */
export function parseTrustTxt(text: string): TrustDeclarations | null {
  if (/^\s*</.test(text)) return null;
  const out: TrustDeclarations = {
    ...(Object.fromEntries(LINK_KEYS.map((k) => [k, [] as string[]])) as Record<LinkKey, string[]>),
    datatrainingallowed: null,
  };
  let known = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    const m = line.match(/^([A-Za-z]+)\s*=\s*(\S+)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    if (key === "datatrainingallowed") {
      const v = value.toLowerCase();
      if (v === "yes" || v === "true") out.datatrainingallowed = true;
      else if (v === "no" || v === "false") out.datatrainingallowed = false;
      else continue;
      known++;
    } else if ((LINK_KEYS as readonly string[]).includes(key)) {
      out[key as LinkKey].push(value);
      known++;
    }
  }
  return known ? out : null;
}

/** Registrable-looking domain of a declared URL (`https://www.ap.org/` → `ap.org`). */
export function trustDomain(value: string): string | null {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Fetches the trust.txt of an origin (`https://example.org`): the well-known location first,
 * then the root one. Network errors and invalid files mean "no declaration".
 */
export async function fetchTrustTxt(origin: string): Promise<TrustRecord | null> {
  for (const url of [`${origin}/.well-known/trust.txt`, `${origin}/trust.txt`]) {
    try {
      const res = await botGet(url, "text/plain");
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      if ((res.headers.get("content-type") ?? "").includes("html")) {
        await res.body?.cancel();
        continue;
      }
      const parsed = parseTrustTxt(await res.text());
      if (parsed) return { url: res.url || url, ...parsed };
    } catch {
      // Unreachable or timed out: try the next location.
    }
  }
  return null;
}

export function loadTrust(): TrustSnapshot | null {
  return fs.existsSync(TRUST_FILE) ? (JSON.parse(fs.readFileSync(TRUST_FILE, "utf8")) as TrustSnapshot) : null;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

/**
 * Checks every registry domain, then the domains their files point to as association or owner
 * (one hop), so that each link can be confirmed from the other side. Saves sources/trust.json.
 */
export async function updateTrust(registryDomains: string[]): Promise<TrustSnapshot> {
  const files: Record<string, TrustRecord> = {};
  const missing: string[] = [];
  const check = async (domains: string[]) => {
    const found = await mapLimited(domains, 8, (d) => fetchTrustTxt(`https://${d}`));
    domains.forEach((d, i) => (found[i] ? (files[d] = found[i]!) : missing.push(d)));
  };
  const first = [...new Set(registryDomains)].sort();
  await check(first);
  const targets = new Set(
    Object.values(files)
      .flatMap((f) => [...f.belongto, ...f.controlledby])
      .map(trustDomain)
      .filter((d): d is string => !!d && !first.includes(d)),
  );
  await check([...targets].sort());
  const snapshot: TrustSnapshot = {
    checkedAt: new Date().toISOString().slice(0, 10),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    missing: missing.sort(),
  };
  fs.writeFileSync(TRUST_FILE, `${JSON.stringify(snapshot, null, 1)}\n`);
  return snapshot;
}

export type TrustLink = { domain: string; confirmed: boolean };
export type TrustSummary = {
  domain: string;
  url: string;
  /** Declared owners; confirmed when the owner's file lists this domain with `control=`. */
  owners: TrustLink[];
  /** Declared associations; confirmed when the association's file lists this domain with `member=`. */
  affiliations: TrustLink[];
  datatrainingallowed: boolean | null;
};

/** What one domain declares, with each link checked against the other side's file. */
export function summarizeTrust(snapshot: TrustSnapshot, domain: string): TrustSummary | null {
  const file = snapshot.files[domain];
  if (!file) return null;
  const lists = (other: string, key: "control" | "member") =>
    (snapshot.files[other]?.[key] ?? []).some((v) => trustDomain(v) === domain);
  const links = (values: string[], key: "control" | "member") =>
    [...new Set(values.map(trustDomain).filter((d): d is string => !!d && d !== domain))].map((d) => ({
      domain: d,
      confirmed: lists(d, key),
    }));
  return {
    domain,
    url: file.url,
    owners: links(file.controlledby, "control"),
    affiliations: links(file.belongto, "member"),
    datatrainingallowed: file.datatrainingallowed,
  };
}
