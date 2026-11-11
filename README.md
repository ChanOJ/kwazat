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

Requires Node.js ≥ 22 and pnpm.

```bash
pnpm install
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

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

The model defaults to `claude-opus-5-5` (override with `WAZA_MODEL` or `--model`).
Requests use the API's server-side refusal fallback.
