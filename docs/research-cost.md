# Research cost and caches

How a research section spends money, what is cached, and how to iterate on a playbook without
paying again for the same press articles.

## Where the money goes

Per section with the default config (Brave, Sonnet for notes, Haiku for the rest), measured on
local runs from 2026-11-11 to 2026-11-20 (about $0.12 to $0.15 per section):

| Stage | Model / service | Share of a section's cost |
|---|---|---|
| notes | Sonnet, ~40-50k input tokens (search results + fetched pages) | ~80-85% |
| search | Brave, $0.005 per query, 4 queries | ~14% |
| plan, triage, extraction | Haiku | under 5% together |
| fetch | KwazatBot | free |

Those runs only recorded the total; the split above is derived from their token counts and the
prices in `claude.ts`. Runs now store the exact split in `section_runs.usage.stages` (`plan`,
`search`, `triage`, `notes`, `extraction`, or `research` with `--search-provider anthropic`).

So the notes step dominates: reusing the gathered sources saves the Brave queries, and reusing
the notes is what saves real money.

## Cache layers

| Layer | Table | Key | Reused when |
|---|---|---|---|
| Search results | `search_cache` | provider, normalized query, language, country, count | same query within the retention |
| Fetched pages | `page_cache` | normalized URL | within the retention and the publisher still allows AI processing |
| Corpus (plan, search, triage, fetch) | `research_corpora` | `gatherHash` + the subject | younger than the section's `ttl_days` |
| Notes | `section_runs.research_notes` | `notesHash` + corpus id | younger than the section's `ttl_days` |
| Items | `facts`, `relations` | `sectionHash` | the section is up to date: nothing runs |

Which playbook field belongs to which key is documented in the header of
`playbooks/person.yaml` and in `playbook.ts`. In short: `search_topic`, sources and budgets
gather again; `instructions`, `scope` and `style` only re-write notes; `item_schema` and
relations only re-extract. A section without `search_topic` gives its instructions to the
planner, so rewording them gathers again: give every section a `search_topic`.

Retention (days, `KWAZAT_SEARCH_CACHE_DAYS`, `KWAZAT_PAGE_CACHE_DAYS`,
`KWAZAT_CORPUS_CACHE_DAYS`): 90 / 90 / 365 with the local PGlite database, 3 / 2 / 30 with a
remote `DATABASE_URL` (staging, production). Expired rows are deleted at each run.

`page_cache` holds third-party article text: it stays in the database (git-ignored `.data/` in
development), never goes into git or eval reports, and is never filled for a publisher refusing
AI processing. The publisher's policy (registry, robots.txt, TDMRep) is checked again before
every use of a cached page or a stored corpus, so a later opt-out takes effect at once.

## Iterating cheaply on a section

1. Gather once (paid: planner, Brave, triage, notes, extraction):

   ```bash
   pnpm research "Rammstein" --type band --sections members_conduct
   ```

2. Edit the section's `instructions` (or the playbook `style`) and run again: the corpus is
   reused, only the notes and the extraction are paid. Editing `item_schema` only pays the
   extraction (Haiku, under a cent).

3. To be sure nothing is gathered again, even after editing `search_topic` or the sources,
   replay the stored corpus:

   ```bash
   pnpm research "Rammstein" --type band --sections members_conduct --frozen-corpus
   ```

   It never calls the planner or Brave (no Brave key needed) and fails a section that has no
   stored corpus yet. `KWAZAT_FROZEN_CORPUS=1` does the same for a whole session.

4. Draft the wording with a cheaper notes model, then check the final version with Sonnet:

   ```bash
   pnpm research "Rammstein" --type band --sections members_conduct --frozen-corpus --research-model claude-haiku-5-5
   ```

5. When the sources themselves should change (new articles, new queries), rebuild the corpus,
   bypassing the search and page caches:

   ```bash
   pnpm research "Rammstein" --type band --sections members_conduct --refresh-corpus
   ```

`--force` re-runs the notes and the extraction of an up-to-date section, but still reuses the
stored corpus.

## Not done yet

- `pnpm eval` uses a fresh database per run, so it does not benefit from these caches; the
  Message Batches API (half price, results within 24 hours) would suit it, as it has no user
  waiting.
- With `--search-provider anthropic`, search and notes are one call: only the notes reuse
  applies.
