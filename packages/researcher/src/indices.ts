/**
 * Country indices used to qualify sources by their home country (see sources/README.md):
 * - V-Dem (via Our World in Data): regime type and judicial constraints on the executive;
 * - RSF World Press Freedom Index: press freedom score;
 * - World Bank Worldwide Governance Indicators: Voice and Accountability, Rule of Law.
 *
 * `pnpm indices` downloads them into sources/countries.json (committed, dated, with source URLs).
 * The thresholds that turn them into a country status live in sources.ts (countryStatus).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const COUNTRIES_FILE = path.resolve(here, "../../../sources/countries.json");

const USER_AGENT = "WazaResearcher/0.1 (development)";
const OWID_REGIME = "https://ourworldindata.org/grapher/political-regime.csv?useColumnShortNames=true";
const OWID_JUDICIAL =
  "https://ourworldindata.org/grapher/judicial-constraints-on-the-executive-index.csv?useColumnShortNames=true";
const RSF_CSV = (year: number) => `https://rsf.org/sites/default/files/import_classement/${year}.csv`;
const WB_COUNTRIES = "https://api.worldbank.org/v2/country?format=json&per_page=400";
const WB_INDICATOR = (id: string) =>
  `https://api.worldbank.org/v2/country/all/indicator/${id}?source=3&format=json&mrnev=1&per_page=1000`;

export type CountryIndices = {
  name: string;
  /** V-Dem Regimes of the World: closed autocracy, electoral autocracy, electoral democracy, liberal democracy. */
  vdemRegime: string | null;
  vdemRegimeYear: number | null;
  /** V-Dem judicial constraints on the executive, 0 (none) to 1. */
  vdemJudicial: number | null;
  vdemJudicialYear: number | null;
  /** RSF press freedom score, 0 to 100 (below 40 = "very serious"). */
  rsfScore: number | null;
  /** World Bank WGI scores (0-100) and their percentile among all countries (0 = worst). */
  wgiVoice: number | null;
  wgiVoicePercentile: number | null;
  wgiRuleOfLaw: number | null;
  wgiRuleOfLawPercentile: number | null;
  wgiYear: number | null;
};

export type CountriesFile = {
  generatedAt: string;
  sources: { id: string; url: string; year: number | null }[];
  countries: Record<string, CountryIndices>;
};

async function get(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) return res;
    if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

/** Latest value per ISO3 code from an OWID grapher CSV (entity,code,year,value,...). */
async function owidLatest(url: string): Promise<Map<string, { year: number; value: string }>> {
  const text = await (await get(url)).text();
  const out = new Map<string, { year: number; value: string }>();
  for (const line of text.split("\n").slice(1)) {
    // Entity names may contain commas inside quotes: parse from the right-hand columns.
    const m = line.match(/,([A-Z]{3}),(\d{4}),([^,]*)/);
    if (!m) continue;
    const [, code, yearStr, value] = m as unknown as [string, string, string, string];
    const year = Number(yearStr);
    if (value !== "" && (!out.has(code) || out.get(code)!.year < year)) out.set(code, { year, value });
  }
  return out;
}

async function rsfLatest(): Promise<{ year: number; url: string; scores: Map<string, number> }> {
  for (let year = new Date().getFullYear(); year >= 2022; year--) {
    const url = RSF_CSV(year);
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("csv")) continue;
    const text = new TextDecoder("latin1").decode(await res.arrayBuffer());
    const [header, ...rows] = text.split(/\r?\n/);
    const cols = header!.split(";");
    const iso = cols.indexOf("ISO");
    const score = cols.findIndex((c) => c.startsWith("Score "));
    const scores = new Map<string, number>();
    for (const row of rows) {
      const cells = row.split(";");
      const value = Number(cells[score]?.replace(",", "."));
      if (cells[iso] && Number.isFinite(value)) scores.set(cells[iso]!, value);
    }
    return { year, url, scores };
  }
  throw new Error("No RSF index CSV found");
}

type WbRow = { countryiso3code: string; date: string; value: number | null };

async function wgi(id: string, countries: Set<string>) {
  const json = (await (await get(WB_INDICATOR(id))).json()) as [unknown, WbRow[]];
  const rows = json[1].filter((r) => countries.has(r.countryiso3code) && r.value !== null);
  const sorted = rows.map((r) => r.value!).sort((a, b) => a - b);
  // Percentile rank among countries: share of countries with a strictly lower score.
  const percentile = (v: number) => Math.round((100 * sorted.findIndex((x) => x >= v)) / sorted.length);
  return new Map(
    rows.map((r) => [r.countryiso3code, { value: r.value!, percentile: percentile(r.value!), year: Number(r.date) }]),
  );
}

export async function updateIndices(): Promise<CountriesFile> {
  // ISO3 → ISO2 and names from the World Bank country list (aggregates such as regions excluded).
  const wbCountries = ((await (await get(WB_COUNTRIES)).json()) as [unknown, any[]])[1].filter(
    (c) => c.region?.id !== "NA" && /^[A-Z]{2}$/.test(c.iso2Code),
  );
  const iso3to2 = new Map<string, { iso2: string; name: string }>(
    wbCountries.map((c) => [c.id as string, { iso2: c.iso2Code as string, name: c.name as string }]),
  );
  const real = new Set(iso3to2.keys());

  const [regime, judicial, rsf, voice, rule] = await Promise.all([
    owidLatest(OWID_REGIME),
    owidLatest(OWID_JUDICIAL),
    rsfLatest(),
    wgi("GOV_WGI_VA.SC", real),
    wgi("GOV_WGI_RL.SC", real),
  ]);

  const countries: Record<string, CountryIndices> = {};
  for (const [iso3, { iso2, name }] of [...iso3to2].sort(([, a], [, b]) => a.iso2.localeCompare(b.iso2))) {
    const r = regime.get(iso3);
    const j = judicial.get(iso3);
    const v = voice.get(iso3);
    const l = rule.get(iso3);
    countries[iso2] = {
      name,
      vdemRegime: r ? r.value.toLowerCase() : null,
      vdemRegimeYear: r?.year ?? null,
      vdemJudicial: j ? Number(j.value) : null,
      vdemJudicialYear: j?.year ?? null,
      rsfScore: rsf.scores.get(iso3) ?? null,
      wgiVoice: v ? Math.round(v.value * 10) / 10 : null,
      wgiVoicePercentile: v?.percentile ?? null,
      wgiRuleOfLaw: l ? Math.round(l.value * 10) / 10 : null,
      wgiRuleOfLawPercentile: l?.percentile ?? null,
      wgiYear: v?.year ?? l?.year ?? null,
    };
  }
  const latest = (m: Map<string, { year: number }>) => Math.max(...[...m.values()].map((x) => x.year));
  const file: CountriesFile = {
    generatedAt: new Date().toISOString().slice(0, 10),
    sources: [
      { id: "vdem_regime", url: OWID_REGIME, year: latest(regime) },
      { id: "vdem_judicial", url: OWID_JUDICIAL, year: latest(judicial) },
      { id: "rsf", url: rsf.url, year: rsf.year },
      { id: "wgi_voice", url: WB_INDICATOR("GOV_WGI_VA.SC"), year: latest(voice) },
      { id: "wgi_rule_of_law", url: WB_INDICATOR("GOV_WGI_RL.SC"), year: latest(rule) },
    ],
    countries,
  };
  fs.writeFileSync(COUNTRIES_FILE, `${JSON.stringify(file, null, 1)}\n`);
  return file;
}

export function loadCountries(): CountriesFile | null {
  return fs.existsSync(COUNTRIES_FILE) ? (JSON.parse(fs.readFileSync(COUNTRIES_FILE, "utf8")) as CountriesFile) : null;
}
