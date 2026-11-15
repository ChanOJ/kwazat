# Waza

Type the name of a public figure, brand or product and get a neutral, sourced fact sheet
(convictions, ongoing cases, investigative revelations, controversies, political affiliation,
notable relations, ownership...). Logged-in users will define "red lines" and get a
personalised compatibility score computed from the entity graph.

Coverage is worldwide and everything is stored in English; localisation happens in the apps.

## Status: phase 0 — researcher CLI

Tune playbooks and measure quality/cost before building the web app.

```
playbooks/            One YAML playbook per entity type (sections, instructions, schemas, sources)
packages/db/          Drizzle schema + local embedded Postgres (PGlite) + migrations
packages/researcher/  Wikidata resolution, Claude research/extraction pipeline, CLI, eval runner
eval/golden/          Golden set per playbook (expected Wikidata ids + fact checks)
eval/reports/         Eval reports (git-ignored)
```

### How a sheet is built

1. **Resolution** — the query is matched against Wikidata (humans only for persons). Several
   candidates → the user picks one (homonym protection). The Wikidata id is the entity key.
2. **Identity + family/party relations** — deterministic, from Wikidata (no LLM).
3. **Each research section**, independently:
   - *research*: Claude with web search/fetch writes sourced notes;
   - *extraction*: Claude converts the notes to strict JSON (structured outputs);
   - *verification*: each source URL is checked against the URLs actually retrieved.
     Unverified items and every item of a `sensitive` section are stored as `needs_review`.
4. Each section run stores a **hash** of its definition (section + style + sources + model).
   Editing a playbook section makes that section stale on every sheet; other sections are kept.

## Setup

Requires Node.js ≥ 22, pnpm, and a logged-in [Proton Pass CLI](https://proton.me/pass) (`pass-cli`).

```bash
pnpm install
```

### Secrets

No secret is ever stored in a file. `secrets.env` (committed) only holds **Proton Pass
references**; the root scripts `pnpm research` and `pnpm eval` run through
`pass-cli run --env-file secrets.env -- ...`, which injects the values at runtime.

| Secret | Local development | CI (GitHub Actions) | Production (Scaleway) |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Proton Pass, vault `Waza`, item `anthropic-api-key` | repository secret | Secret Manager |

Use a separate Anthropic key per environment, each in a workspace with its own spend limit.
`pnpm sheet` and `pnpm research ... --identity-only` need no secret.

### Run settings (not secrets)

Defaults are tuned for cost during the design phase. Override with CLI flags or env variables:

| Flag | Env variable | Default | Notes |
|---|---|---|---|
| `--research-model` | `WAZA_RESEARCH_MODEL` | `claude-sonnet-5-5` | Web research: judgement, cross-checking, homonyms |
| `--extract-model` | `WAZA_EXTRACT_MODEL` | `claude-haiku-5-5` | Mechanical notes → JSON conversion |
| `--effort` | `WAZA_RESEARCH_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max` |
| `--max-searches` | `WAZA_MAX_SEARCHES` | `4` | Cap per section (each search is billed ~$0.01) |
| `--max-fetches` | `WAZA_MAX_FETCHES` | `2` | Cap per section |

These settings are part of each section's hash: changing them marks cached sections as stale.
Reports split the cost between model tokens and web searches.

## Usage

```bash
# Identity only (free: Wikidata, no LLM call)
pnpm research "François Fillon" --identity-only        # lists homonyms
pnpm research "François Fillon" --pick 1 --identity-only

# Full research (paid: Claude API + web search), or only some sections
pnpm research Q101410
pnpm research Q101410 --sections convictions,ongoing_cases
pnpm research Q101410 --force                          # ignore cached sections

# Print a stored sheet (--all includes items pending review)
pnpm sheet Q101410 --all

# Run the golden set (isolated database, always re-researches; paid)
pnpm eval person
pnpm eval person --only "Jérôme Cahuzac" --sections convictions

# After editing packages/db/src/schema.ts
pnpm db:generate
```

To compare quality and cost, run the same eval with another configuration, e.g.
`pnpm eval person --research-model claude-opus-5-5 --max-searches 8`.
Requests to models that support it use the API's server-side refusal fallback (not Haiku).
