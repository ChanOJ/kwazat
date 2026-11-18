# Source registry

Which outlets and official websites the researcher may use, and how much each one is trusted.
One file per country (ISO 3166-1 alpha-2 code, e.g. `FR.yaml`) plus `international.yaml`.

## How sources are selected for a query

1. **Countries of the subject** come from Wikidata (persons: citizenship, P27). The
   international file is always included.
2. **Types**: each playbook section lists the source types it wants (e.g. `convictions` wants
   courts, wires, newspapers, broadcasters, investigative outlets).
3. **Mode**:
   - `restricted` (sensitive sections): web search and fetch are limited to the non-tier-3
     domains of the selected types, from the subject's countries and the international file.
     The section falls back to `preferred` when a subject country has no registry file yet or
     is flagged by the country indices (see below).
   - `preferred`: the model gets the same list as preferred outlets and is free to use others;
     `excluded` domains are always blocked.
4. **Confidence** is capped in code by the best verified source: tier 1 → high, tier 2,
   unrated or outside the registry → medium, tier 3 → low, no verified source → low.

The selected list is part of each section's hash: editing a country file marks the sections
of the people from that country as stale.

## Tiers: computed, never set by hand

Nobody gives an outlet a grade: a tier is computed in code (`packages/researcher/src/sources.ts`,
`computeTier`) from public, checkable evidence, so that any classification can be audited and
contested with a document rather than an opinion. The only human choices are the rules below
(which indices, which thresholds): they are public and versioned, and changing them recomputes
every affected sheet.

### 1. Country of the source

Three independent indices, downloaded with `pnpm indices` into `countries.json` (dated, with the
URL of each dataset). The file is not committed: the data belongs to its publishers (V-Dem via
Our World in Data under CC BY, World Bank under CC BY 4.0, RSF under its own terms, to be
checked before any public redistribution). Run `pnpm indices` after cloning.

| Index | Used for | Below the threshold when |
|---|---|---|
| [V-Dem](https://v-dem.net) (University of Gothenburg), via Our World in Data | regime type; judicial constraints on the executive | closed or electoral autocracy; judicial constraints < 0.5 |
| [RSF World Press Freedom Index](https://rsf.org/en/index) | press freedom | score < 40 ("very serious") |
| [World Bank Worldwide Governance Indicators](https://www.worldbank.org/en/publication/worldwide-governance-indicators) | voice and accountability; rule of law | bottom quartile of countries |

A country is flagged only when **at least two of the three** agree, so no single organisation
decides:

- **press freedom** flagged (RSF, V-Dem regime, World Bank voice and accountability) → every
  media outlet based there is tier 3, whatever its own evidence;
- **rule of law** flagged (V-Dem judicial constraints, V-Dem regime, World Bank rule of law) →
  its courts, parliament, government bodies and regulators are tier 3: their decisions are
  reported as attributed positions ("according to the X court"), never as established facts;
- **state media**: an outlet with a `state_owned` signal is tier 3 when the owning state's press
  freedom is flagged, wherever it is based.

The home country of a source is its file's country, or `home` for entries of
`international.yaml`. Exile media are filed under the country they operate from.

When a subject's own country is flagged, sensitive sections are not restricted to the registry
(the best sources are then foreign and exile media and UN bodies), and the research prompt
explains the country context and points to UN human rights bodies (e.g. the Working Group on
Arbitrary Detention).

### 2. Signals of the outlet

| Signal | Meaning | Evidence |
|---|---|---|
| `official` | Public institution publishing its own decisions or records (court, parliament, regulator, registry, UN body) | None needed |
| `independence_guarantee` | Editorial independence protected by law or by a binding structure (statute, trust, charter with veto rights) | The statute or governance document |
| `jti_certified` | Certified under the Journalism Trust Initiative (ISO-based standard run by RSF, external audit) | Certification announcement or JTI report |
| `ifcn_signatory` | Fact-checking desk signatory of the International Fact-Checking Network code | IFCN page |
| `press_council_member` | Member of the national press council (France: CDJM) | Council page |
| `regulator_sanction` | Fined or formally sanctioned by the media regulator for honesty, rigour or pluralism (`date` required) | Decision or press report |
| `opinion_outlet` | Describes itself as an opinion or advocacy outlet | Its own "about" page |
| `state_owned` | Owned or controlled by a state (`state` required) | e.g. [State Media Monitor](https://statemediamonitor.com) |
| `newsroom_dispute` | Strike or collective departure of the newsroom over its editorial independence from the owner (`date` required) | An official source, or `evidence` + `corroboration` from at least two distinct domains, one of them tier 1, none tier 3 or owned by the same owner (checked at load) |

### 3. Owner record

Owning an outlet never lowers its tier by itself. What counts is a documented pattern: when at
least **two outlets of the same owner** (`owner_id`, groups defined in `owners.yaml`) have a
regulator sanction or a newsroom dispute less than 5 years old, the owner is flagged and **all
its outlets are tier 3**. The rule is the same for every owner; allegations (testimonies,
denied accounts, e.g. in the 2022 Senate inquiry on media concentration) do not count until a
decision or a documented event confirms them.

Separately, conflicts of interest depend on the subject (an outlet reporting on its own owner
or on people linked to it): they will be handled per query with the brand graph.

### 4. Rules, in order

1. Home country flagged (see above), state media of a flagged state, or flagged owner → **tier 3**.
2. `regulator_sanction` less than 5 years old, or `opinion_outlet` → **tier 3**
   (usable to report positions, "X says", never as the only source of a fact).
3. `official`, `independence_guarantee` or `jti_certified` → **tier 1**.
4. `ifcn_signatory` or `press_council_member` → **tier 2**.
5. Otherwise **unrated** (`[-]` in `pnpm sources`): usable, confidence capped at medium, like an
   outlet outside the registry. Collecting evidence is what moves an outlet out of this state.

## Fetching policy (KwazatBot)

Kwazat references facts and links back to the publisher for the full story; it never republishes
articles. Pages are read by KwazatBot (`packages/researcher/src/fetcher.ts`) within the
publishers' stated wishes:

- it identifies itself as `KwazatBot` (never as a browser) and obeys robots.txt rules addressed to
  it or to every robot;
- a robots.txt that blocks known AI agents (GPTBot, ClaudeBot, CCBot, Google-Extended...), a TDM
  reservation (W3C TDMRep: `tdmrep.json`, HTTP header or meta tag) or a refusal written in plain
  text recorded in the registry (`ai_opt_out`) means "no AI processing": only the search
  engine's title and snippets are used, with the link;
- paywalls and logins are never bypassed: only what the page serves publicly is read;
- page texts are not stored: only extracted facts, quotes of 25 words at most, and URLs.

## Reachability (Claude web tools only)

With `--search-provider anthropic`, many publishers block Anthropic's crawler: their pages never appear in the web tools' results,
and listing one of them in `allowed_domains` makes the whole request fail. `pnpm reach` checks
every registry domain in one free request and stores the blocked ones in `access.json`; research
requests also record new ones automatically. Unreachable domains are left out of the selected
sources (they stay in the registry: they still count when an outlet cites them indirectly, and
they may become reachable through another search provider).

## Fields

| Field | Meaning |
|---|---|
| `domain` | Registrable domain, without `www.` (subdomains are included) |
| `name` | Display name |
| `types` | One or more of the types below |
| `home` | ISO country code, for entries of `international.yaml` based in one country |
| `signals` | List of `{ id, evidence, date?, state?, note? }` (see above); `evidence` is required except for `official` |
| `languages` | ISO 639-1 codes |
| `ai_opt_out` | `{ evidence, note }`: refusal of AI processing written in plain text (snippets only) |
| `owner_id` | Owner group from `owners.yaml` (see "Owner record") |
| `owner` | Main owner, informative. Will be replaced by a link to the owner entity in the brand graph |
| `notes` | Factual remarks only (never an assessment) |

Types: `wire`, `newspaper`, `magazine`, `broadcaster`, `investigative`, `fact_check`, `court`,
`parliament`, `government`, `regulator`, `registry`, `consumer_safety`, `international_org`.

`excluded` lists domains that are never used (content farms, disinformation, satire...).
