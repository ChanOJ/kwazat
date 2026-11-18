/**
 * Source registry (sources/*.yaml): which outlets and official sites the researcher uses for a
 * given subject and section, and how much each one is trusted. See sources/README.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { loadAccess } from "./access.ts";
import { loadCountries, type CountriesFile } from "./indices.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SOURCES_DIR = path.resolve(here, "../../../sources");

export const SOURCE_TYPES = [
  "wire",
  "newspaper",
  "magazine",
  "broadcaster",
  "investigative",
  "fact_check",
  "court",
  "parliament",
  "government",
  "regulator",
  "registry",
  "consumer_safety",
  "international_org",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SourceTypeSchema = z.enum(SOURCE_TYPES);

const Domain = z
  .string()
  .regex(/^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "bare lowercase domain without www. or path");

export type Tier = 1 | 2 | 3;
const CountryCode = z.string().regex(/^[A-Z]{2}$/);

/** Public, checkable facts about an outlet. See sources/README.md for definitions. */
export const SIGNALS = [
  "official",
  "independence_guarantee",
  "jti_certified",
  "ifcn_signatory",
  "press_council_member",
  "regulator_sanction",
  "opinion_outlet",
  "state_owned",
  "newsroom_dispute",
] as const;
export type SignalId = (typeof SIGNALS)[number];
/** What decided a tier: a signal of the outlet, or the status of its home country / owner state. */
export type Basis = SignalId | "country_press_freedom" | "country_rule_of_law" | "state_media" | "owner_record";

const Signal = z
  .object({
    id: z.enum(SIGNALS),
    evidence: z.url().optional(),
    date: z.iso.date().optional(),
    /** For state_owned: ISO code of the owning state. */
    state: CountryCode.optional(),
    /** Further independent sources for the same fact (required for newsroom_dispute). */
    corroboration: z.array(z.url()).optional(),
    note: z.string().optional(),
  })
  .refine((s) => s.id === "official" || !!s.evidence, { message: "evidence URL required (except for official)" })
  .refine((s) => (s.id !== "regulator_sanction" && s.id !== "newsroom_dispute") || !!s.date, {
    message: "regulator_sanction and newsroom_dispute require a date",
  })
  .refine((s) => s.id !== "state_owned" || !!s.state, { message: "state_owned requires the owning state" });
type Signal = z.infer<typeof Signal>;

const RawSourceEntry = z.object({
  domain: Domain,
  name: z.string(),
  types: z.array(SourceTypeSchema).min(1),
  /** Home country, for entries of international.yaml based in a given country. */
  home: CountryCode.optional(),
  signals: z.array(Signal).default([]),
  languages: z.array(z.string().length(2)).optional(),
  owner: z.string().optional(),
  /** Refusal of AI processing written in plain text (e.g. in robots.txt comments or terms). */
  ai_opt_out: z.object({ evidence: z.url(), note: z.string().optional() }).optional(),
  /** Owner group, defined in sources/owners.yaml (until the brand graph provides ownership). */
  owner_id: z.string().optional(),
  notes: z.string().optional(),
});
type RawSourceEntry = z.infer<typeof RawSourceEntry>;

/** A registry entry with its computed tier. */
export type SourceEntry = RawSourceEntry & {
  country: string;
  /** null = unrated: no signal decides the tier yet (treated like an outlet outside the registry). */
  tier: Tier | null;
  /** What decided the tier (empty when unrated). */
  basis: Basis[];
};

// --- Country status --------------------------------------------------------------------------

const AUTOCRACIES = new Set(["closed autocracy", "electoral autocracy"]);
/** RSF "very serious" category. */
const RSF_VERY_SERIOUS = 40;
/** Bottom quartile of countries in the World Bank governance indicators. */
const WGI_LOW_PERCENTILE = 25;
const VDEM_JUDICIAL_LOW = 0.5;
/** How many of the three indices must agree before a country is flagged. */
const INDICES_REQUIRED = 2;

export type CountryFlag = { low: boolean; reasons: string[] };
export type CountryStatus = { code: string; name: string; pressFreedom: CountryFlag; ruleOfLaw: CountryFlag };

/**
 * Flags a country when at least two of three independent indices place it below the threshold
 * (see sources/README.md): one organisation alone never decides.
 */
export function countryStatus(code: string, data: CountriesFile | null): CountryStatus | null {
  const c = data?.countries[code];
  if (!c) return null;
  const autocracy = c.vdemRegime && AUTOCRACIES.has(c.vdemRegime) ? [`V-Dem ${c.vdemRegimeYear}: ${c.vdemRegime}`] : [];
  const flag = (reasons: string[]): CountryFlag => ({ low: reasons.length >= INDICES_REQUIRED, reasons });
  return {
    code,
    name: c.name,
    pressFreedom: flag([
      ...(c.rsfScore !== null && c.rsfScore < RSF_VERY_SERIOUS ? [`RSF: ${c.rsfScore}/100 (very serious)`] : []),
      ...autocracy,
      ...(c.wgiVoicePercentile !== null && c.wgiVoicePercentile < WGI_LOW_PERCENTILE
        ? [`World Bank ${c.wgiYear}: voice and accountability, percentile ${c.wgiVoicePercentile}`]
        : []),
    ]),
    ruleOfLaw: flag([
      ...(c.vdemJudicial !== null && c.vdemJudicial < VDEM_JUDICIAL_LOW
        ? [`V-Dem ${c.vdemJudicialYear}: judicial constraints on the executive ${c.vdemJudicial}`]
        : []),
      ...autocracy,
      ...(c.wgiRuleOfLawPercentile !== null && c.wgiRuleOfLawPercentile < WGI_LOW_PERCENTILE
        ? [`World Bank ${c.wgiYear}: rule of law, percentile ${c.wgiRuleOfLawPercentile}`]
        : []),
    ]),
  };
}

/** Courts, parliaments, governments, regulators, registries: judged on the rule of law. */
const INSTITUTION_TYPES = new Set<SourceType>([
  "court",
  "parliament",
  "government",
  "regulator",
  "registry",
  "consumer_safety",
  "international_org",
]);
const isInstitution = (types: SourceType[], signals: Signal[]) =>
  signals.some((s) => s.id === "official") || types.every((t) => INSTITUTION_TYPES.has(t));

/** Sanctions and newsroom disputes older than this no longer count. */
const RECORD_WINDOW_YEARS = 5;
/** Distinct outlets of the same owner with a recent record before the owner is flagged. */
const OWNER_RECORD_OUTLETS = 2;

function isRecent(date: string | undefined, today: Date) {
  const cutoff = new Date(today);
  cutoff.setFullYear(cutoff.getFullYear() - RECORD_WINDOW_YEARS);
  return !!date && new Date(date) >= cutoff;
}

/**
 * Tier from evidence, rules applied in order (see sources/README.md):
 * 1. home country flagged (rule of law for institutions, press freedom for media), or state media
 *    of a country with flagged press freedom → 3;
 * 2. recent regulator sanction or opinion outlet → 3;
 * 3. official, independence guarantee or JTI → 1;
 * 4. IFCN or press council → 2;
 * 5. otherwise unrated (null).
 */
export function computeTier(
  entry: Pick<RawSourceEntry, "types" | "signals">,
  home: CountryStatus | null,
  stateOf: (code: string) => CountryStatus | null,
  today = new Date(),
): { tier: Tier | null; basis: Basis[] } {
  const { types, signals } = entry;
  if (home) {
    if (isInstitution(types, signals) ? home.ruleOfLaw.low : home.pressFreedom.low) {
      return { tier: 3, basis: [isInstitution(types, signals) ? "country_rule_of_law" : "country_press_freedom"] };
    }
  }
  if (signals.some((s) => s.id === "state_owned" && stateOf(s.state!)?.pressFreedom.low)) {
    return { tier: 3, basis: ["state_media"] };
  }

  const active = signals.filter((s) => s.id !== "regulator_sanction" || isRecent(s.date, today));
  const has = (ids: SignalId[]) => [...new Set(active.filter((s) => ids.includes(s.id)).map((s) => s.id))];
  const rules: [Tier, SignalId[]][] = [
    [3, ["regulator_sanction", "opinion_outlet"]],
    [1, ["official", "independence_guarantee", "jti_certified"]],
    [2, ["ifcn_signatory", "press_council_member"]],
  ];
  for (const [tier, ids] of rules) {
    const basis = has(ids);
    if (basis.length) return { tier, basis };
  }
  return { tier: null, basis: [] };
}

const RegistryFile = z.object({
  country: z.union([z.literal("international"), CountryCode]),
  languages: z.array(z.string().length(2)).optional(),
  sources: z.array(RawSourceEntry).default([]),
  excluded: z.array(z.object({ domain: Domain, reason: z.string() })).default([]),
});
type RegistryFile = Omit<z.infer<typeof RegistryFile>, "sources"> & { sources: SourceEntry[] };

const OwnersFile = z.object({
  owners: z.array(
    z.object({ id: z.string(), name: z.string(), wikidata: z.string().regex(/^Q\d+$/).optional(), notes: z.string().optional() }),
  ),
});
export type OwnerRecord = { id: string; name: string; flagged: boolean; reasons: string[] };

export type Registry = {
  files: Map<string, RegistryFile>;
  countries: CountriesFile | null;
  status: (code: string) => CountryStatus | null;
  owners: Map<string, OwnerRecord>;
  /** Domains Claude's web tools cannot reach (sources/access.json; "anthropic" provider only). */
  unreachable: Set<string>;
  /** Domains whose publisher refuses AI processing in plain text: snippets only. */
  aiOptOut: Set<string>;
};

const REGISTRY_FILE = /^([A-Z]{2}|international)\.yaml$/;

export function loadRegistry(dir = SOURCES_DIR, countries: CountriesFile | null = loadCountries()): Registry {
  // Without the indices no country would ever be flagged: fail loudly rather than silently.
  if (!countries) throw new Error("sources/countries.json is missing: run `pnpm indices` (free) first.")
  const cache = new Map<string, CountryStatus | null>();
  const status = (code: string) => {
    if (!cache.has(code)) cache.set(code, countryStatus(code, countries));
    return cache.get(code)!;
  };
  const files = new Map<string, RegistryFile>();
  const seen = new Map<string, string>();
  for (const name of fs.readdirSync(dir).filter((f) => REGISTRY_FILE.test(f)).sort()) {
    const file = path.join(dir, name);
    const result = RegistryFile.safeParse(parse(fs.readFileSync(file, "utf8")));
    if (!result.success) throw new Error(`Invalid source file ${file}:\n${z.prettifyError(result.error)}`);
    const expected = name.replace(/\.yaml$/, "");
    if (result.data.country !== expected) {
      throw new Error(`${file}: country "${result.data.country}" must match the file name`);
    }
    const fileCountry = result.data.country;
    const data: RegistryFile = {
      ...result.data,
      sources: result.data.sources.map((s) => {
        const home = s.home ?? (fileCountry === "international" ? null : fileCountry);
        return { ...s, country: fileCountry, ...computeTier(s, home ? status(home) : null, status) };
      }),
    };
    for (const s of data.sources) {
      const other = seen.get(s.domain);
      if (other) throw new Error(`Domain ${s.domain} is listed in both ${other} and ${name}`);
      seen.set(s.domain, name);
    }
    files.set(fileCountry, data);
  }
  if (!files.has("international")) throw new Error(`Missing ${path.join(dir, "international.yaml")}`);
  const registry: Registry = {
    files,
    countries,
    status,
    owners: new Map(),
    unreachable: new Set(loadAccess().blocked),
    aiOptOut: new Set([...files.values()].flatMap((f) => f.sources.filter((s) => s.ai_opt_out).map((s) => s.domain))),
  };
  validateEvidence(registry);
  applyOwnerRecords(registry, dir);
  return registry;
}

const allSources = (registry: Registry) => [...registry.files.values()].flatMap((f) => f.sources);

/**
 * A newsroom dispute is the most interpretive signal, so its evidence must be strong: an official
 * source, or at least two distinct domains including a tier 1 one, none of them tier 3 and none
 * owned by the outlet's own owner.
 */
function validateEvidence(registry: Registry) {
  for (const entry of allSources(registry)) {
    for (const signal of entry.signals.filter((s) => s.id === "newsroom_dispute")) {
      const urls = [signal.evidence!, ...(signal.corroboration ?? [])];
      const found = urls.map((u) => ({ url: u, host: hostOf(u), entry: lookupSource(registry, u) }));
      const official = found.some((f) => f.entry?.basis.includes("official"));
      const domains = new Set(found.map((f) => f.entry?.domain ?? f.host));
      const ok =
        official ||
        (domains.size >= 2 &&
          found.some((f) => f.entry?.tier === 1) &&
          !found.some((f) => f.entry?.tier === 3) &&
          !found.some((f) => entry.owner_id && f.entry?.owner_id === entry.owner_id));
      if (!ok) {
        throw new Error(
          `${entry.domain}: newsroom_dispute of ${signal.date} needs an official source, or two distinct ` +
            "domains including a tier 1 one, none tier 3 or owned by the same owner",
        );
      }
    }
  }
}

/**
 * Owner record: when several outlets of the same owner have a recent regulator sanction or
 * newsroom dispute, every outlet of that owner is tier 3. The fact held against the owner is
 * then a pattern across its outlets, not a single incident or mere ownership.
 */
function applyOwnerRecords(registry: Registry, dir: string, today = new Date()) {
  const file = path.join(dir, "owners.yaml");
  if (!fs.existsSync(file)) return;
  const result = OwnersFile.safeParse(parse(fs.readFileSync(file, "utf8")));
  if (!result.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(result.error)}`);
  const sources = allSources(registry);
  for (const owner of result.data.owners) {
    const outlets = sources.filter((s) => s.owner_id === owner.id);
    const reasons = outlets.flatMap((s) =>
      s.signals
        .filter((sig) => (sig.id === "regulator_sanction" || sig.id === "newsroom_dispute") && isRecent(sig.date, today))
        .map((sig) => ({ outlet: s.domain, text: `${s.name}: ${sig.id.replace("_", " ")} ${sig.date}` })),
    );
    const flagged = new Set(reasons.map((r) => r.outlet)).size >= OWNER_RECORD_OUTLETS;
    registry.owners.set(owner.id, { id: owner.id, name: owner.name, flagged, reasons: reasons.map((r) => r.text) });
    if (flagged) for (const s of outlets) Object.assign(s, { tier: 3, basis: ["owner_record"] });
  }
  for (const s of sources) {
    if (s.owner_id && !registry.owners.has(s.owner_id)) throw new Error(`${s.domain}: unknown owner_id "${s.owner_id}"`);
  }
}

/** True when `host` is `domain` or one of its subdomains. */
const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export type SourceMode = "restricted" | "preferred";

/** Sources chosen for one subject and one section. Part of the section hash. */
export type SourceSelection = {
  mode: SourceMode;
  /** Registry files used, e.g. ["FR", "international"]. */
  countries: string[];
  /** Subject countries that have no registry file yet (reported, and they disable restriction). */
  uncovered: string[];
  /** Sources of the requested types except tier 3: the whitelist (restricted) or the suggestion list. */
  sources: { domain: string; name: string; tier: Tier | null; country: string }[];
  /** Subject countries flagged by the country indices, with the reasons (shown to the model). */
  flagged: CountryStatus[];
  /** Always blocked in preferred mode (restricted mode already excludes everything else). */
  excluded: string[];
};

/**
 * Picks the sources for a subject: its countries' files plus the international one, filtered by
 * the section's types, tier 3 left out. Sensitive sections are restricted to that list, unless
 * one of the subject's countries has no file yet or is flagged by the country indices.
 */
export function selectSources(
  registry: Registry,
  opts: {
    countryCodes: string[];
    types: SourceType[];
    sensitive: boolean;
    mode?: "auto" | SourceMode;
    /** Leave out domains Claude's web tools cannot reach (only for the "anthropic" provider). */
    skipUnreachable?: boolean;
  },
): SourceSelection {
  const wanted = [...new Set(opts.countryCodes.map((c) => c.toUpperCase()))];
  const covered = wanted.filter((c) => registry.files.has(c));
  const uncovered = wanted.filter((c) => !registry.files.has(c));
  const countries = [...covered, "international"];
  const files = countries.map((c) => registry.files.get(c)!);

  const sources = files
    .flatMap((f) => f.sources)
    .filter(
      (s) =>
        s.tier !== 3 &&
        !(opts.skipUnreachable && registry.unreachable.has(s.domain)) &&
        s.types.some((t) => opts.types.includes(t)),
    )
    .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || a.domain.localeCompare(b.domain))
    .map(({ domain, name, tier, country }) => ({ domain, name, tier, country }));
  const flagged = wanted
    .map((c) => registry.status(c))
    .filter((st): st is CountryStatus => !!st && (st.pressFreedom.low || st.ruleOfLaw.low));

  // Restriction needs every subject country covered by a file and not flagged: for a flagged
  // country the best sources (foreign press, exile media, UN bodies) are mostly outside the lists.
  const restricted = opts.sensitive && covered.length > 0 && uncovered.length === 0 && flagged.length === 0;
  return {
    mode: opts.mode && opts.mode !== "auto" ? opts.mode : restricted ? "restricted" : "preferred",
    countries,
    uncovered,
    sources,
    flagged,
    excluded: [...new Set([...registry.files.values()].flatMap((f) => f.excluded.map((e) => e.domain)))].sort(),
  };
}

/** Registry entry for a URL, searched in every file (a French outlet can cover a US subject). */
export function lookupSource(registry: Registry, url: string): SourceEntry | null {
  const host = hostOf(url);
  if (!host) return null;
  let best: SourceEntry | null = null;
  for (const f of registry.files.values()) {
    for (const s of f.sources) {
      // Longest match wins (e.g. a subdomain listed separately from its parent).
      if (matches(host, s.domain) && (!best || s.domain.length > best.domain.length)) best = s;
    }
  }
  return best;
}

export function isExcluded(registry: Registry, url: string): boolean {
  const host = hostOf(url);
  return !!host && [...registry.files.values()].some((f) => f.excluded.some((e) => matches(host, e.domain)));
}

export type Confidence = "high" | "medium" | "low";
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * Upper bound on an item's confidence from its best verified source:
 * tier 1 → high, tier 2, unrated or unknown outlet → medium, tier 3 / excluded / none verified → low.
 */
export function confidenceCap(registry: Registry, verifiedUrls: string[]): Confidence {
  let cap: Confidence = "low";
  for (const url of verifiedUrls) {
    if (isExcluded(registry, url)) continue;
    const entry = lookupSource(registry, url);
    const c: Confidence = entry?.tier === 1 ? "high" : entry?.tier === 3 ? "low" : "medium";
    if (RANK[c] > RANK[cap]) cap = c;
  }
  return cap;
}

export const minConfidence = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);
