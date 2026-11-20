# Kwazat

Type the name of a public figure, brand or product and get a neutral, sourced fact sheet
(convictions, ongoing cases, investigative revelations, controversies, political affiliation,
notable relations, ownership...). Logged-in users will define "red lines" and get a
personalised compatibility score computed from the entity graph.

Coverage is worldwide and everything is stored in English; localisation happens in the apps.

## Status: phase 0 — researcher CLI, first web app (local only)

Tune playbooks and measure quality/cost; the web app (`packages/app`) is starting, behind
login, so that the owner can work on the UX. It runs locally only for now.

```
playbooks/            One YAML playbook per entity type (sections, instructions, schemas, source types)
sources/              Source registry: trusted outlets and official sites per country (see sources/README.md)
packages/db/          Drizzle schema, migrations, job queue; PGlite locally, Postgres via DATABASE_URL
packages/researcher/  Wikidata resolution, Claude research/extraction pipeline, CLI, eval runner
packages/app/         Web app (Next.js, Better Auth): login, search; see "Web app" below
eval/golden/          Golden set per playbook (expected Wikidata ids + fact checks)
eval/reports/         Eval reports (git-ignored)
```

### How a sheet is built

1. **Resolution** — the query is matched against Wikidata (humans only for persons). Several
   candidates → the user picks one (homonym protection). Candidate lists are cached 24 h and
   Wikidata calls are serialized and throttled; known entities are also searched locally
   (trigram index, typo-tolerant). Entities get Kwazat's own id (UUIDv7); Wikidata ids and other
   external identifiers (GTIN, SIREN, LEI...) live in a correspondence table, and merged
   duplicates redirect to the entity they were merged into.
2. **Identity + family/party relations** — deterministic, from Wikidata (no LLM).
3. **Each research section**, independently:
   - *sources*: outlets are picked from the registry for the subject's countries (Wikidata
     citizenship) plus international ones; sensitive sections can only reach those domains;
   - *research*: a search provider (Brave in alpha, swappable in `src/search/`) finds sources,
     past included; KwazatBot reads the useful pages within the publishers' wishes (publishers
     refusing AI processing are used through search snippets only); Claude writes sourced notes;
   - *extraction*: Claude converts the notes to strict JSON (structured outputs);
   - *verification*: each source URL is checked against the URLs actually retrieved.
     Unverified items and every item of a `sensitive` section are stored as `needs_review`.
     Confidence is capped by the registry tier of the best verified source.
4. Each section run stores a **hash** of its definition (section + style + selected sources + model).
   Editing a playbook section makes that section stale on every sheet; other sections are kept.

## Setup

Requires Node.js ≥ 22, pnpm, and a logged-in [Proton Pass CLI](https://proton.me/pass) (`pass-cli`).

```bash
pnpm install
pnpm indices   # country indices used by the source registry (free, not committed)
pnpm test      # unit and database tests (PGlite and the Postgres wire protocol)
```

### Database

Without configuration, an embedded Postgres (PGlite) is stored in `.data/pglite`: nothing to
install, migrations applied automatically. Set `DATABASE_URL` to use a Postgres server instead
(staging, prod); migrations then run only with `pnpm migrate`, once per deploy. Long tasks go
through a Postgres-backed job queue (`jobs` table,
`FOR UPDATE SKIP LOCKED`), so no extra queue service is needed.

### Secrets

No secret is ever stored in a file. `secrets.env` (committed) only holds **Proton Pass
references**; the root scripts `pnpm research` and `pnpm eval` run through
`pass-cli run --env-file secrets.env -- ...`, which injects the values at runtime.

| Secret | Local development | CI (GitHub Actions) | Production (Scaleway) |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Proton Pass, vault `Kwazat`, item `anthropic-api-key` | repository secret | Secret Manager |
| `BRAVE_SEARCH_API_KEY` | Proton Pass, vault `Kwazat`, item `brave-search-api-key` | repository secret | Secret Manager |

Use a separate Anthropic key per environment, each in a workspace with its own spend limit.
`pnpm sheet` and `pnpm research ... --identity-only` need no secret.

### Run settings (not secrets)

Defaults are tuned for cost during the design phase. Override with CLI flags or env variables:

| Flag | Env variable | Default | Notes |
|---|---|---|---|
| `--research-model` | `KWAZAT_RESEARCH_MODEL` | `claude-sonnet-5-5` | Web research: judgement, cross-checking, homonyms |
| `--extract-model` | `KWAZAT_EXTRACT_MODEL` | `claude-haiku-5-5` | Mechanical notes → JSON conversion |
| `--effort` | `KWAZAT_RESEARCH_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max` |
| `--max-searches` | `KWAZAT_MAX_SEARCHES` | `4` | Cap per section (each search is billed ~$0.01) |
| `--max-fetches` | `KWAZAT_MAX_FETCHES` | `2` | Cap per section (pages read in full) |
| `--search-provider` | `KWAZAT_SEARCH_PROVIDER` | `brave` | `brave` (Web Search + KwazatBot), `brave-context` (LLM Context passages, trimmed to snippets for publishers refusing AI), or `anthropic` (Claude web tools) |
| `--source-mode` | `KWAZAT_SOURCE_MODE` | `auto` | `auto`, `restricted` or `preferred` (see sources/README.md) |

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

# Name search as the API will do it: known entities, then cached Wikidata candidates (free)
pnpm lookup "Jerome Cahusac"

# Show which sources each section would use for a subject (free)
pnpm sources Q57751

# Refresh the country indices (V-Dem, RSF, World Bank) in sources/countries.json (free)
pnpm indices

# List registry domains the web tools cannot reach, into sources/access.json (free API check)
pnpm reach

# Read the trust.txt of registry domains (ownership, affiliations) into sources/trust.json (free)
pnpm trust

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

## Web app

Next.js (App Router) with [Better Auth](https://www.better-auth.com), on the same database as
the sheets (`users`, `sessions`, `accounts`, `verifications`, `two_factors`, see
`packages/db/src/auth-schema.ts`). Runs locally only for now.

**Pages.** Search (known entities, then Wikidata candidates) → a known subject opens its sheet
(`/entity/<id>`: identity, each research section with numbered sources, Wikidata relations). A
subject Kwazat does not know yet is a button, never a link (research is paid and must not start
from a prefetch): it queues a research job and shows a waiting page until the identity is known,
then the sheet, whose sections fill in as they are researched. The profile icon (top right)
opens Account and Red lines (placeholder until red lines are designed).

**Research jobs.** The `research` job (`packages/researcher/src/worker.ts`) runs the identity
step (free) then every research section (paid, one attempt). In development the worker runs
inside the web server (one process, as PGlite requires); `KWAZAT_WORKER=off` disables it, and in
production it only starts with `KWAZAT_WORKER=on` (a separate worker job is the plan).

**Access, phase 1 (now): everything is behind login.** Anonymous visitors are sent to `/login`
and come back to the page they asked for. There is **no signup**: no page, and Better Auth's
signup endpoint is both disabled and removed. Accounts are created with `pnpm users` only. One
file decides access, `packages/app/src/lib/access.ts`, enforced on every request by
`packages/app/src/proxy.ts` (session checked against the database, so removing an account or
changing its password logs it out at once).

**Phase 2** (browsing and search open to everyone, login for settings and personalization):
set `LOGIN_REQUIRED_EVERYWHERE = false` in `access.ts`; paths under `PRIVATE_PREFIXES`
(`/account`, `/red-lines`) keep needing a session. Then remove the `X-Robots-Tag` header of
`next.config.ts` and the `robots` metadata of the root layout for the public pages.

**Account (minimal data, GDPR).** An email address, a password and a **mandatory second factor**,
nothing else (`name` is required by Better Auth and left empty). At the first login, the
account must set one up before reaching any page:

- *code by email*: each login emails a 6-digit code (valid 10 minutes) and a link that opens the
  code page with it filled in (in the browser where the login started);
- *authenticator app* (TOTP), with 10 single-use backup codes.

"Trust this device for 30 days" skips the second step on that browser. The Account page
changes the email address (confirmed from the current address, then verified at the new one),
the password (logs out the other devices), the second factor and the backup codes. An
authenticator being replaced and not confirmed yet falls back to emailed codes, so nobody is
locked out halfway. A user who chose the authenticator can still request an emailed code
through the API: both are second factors tied to the account.

**Languages.** The interface is in English (the reference) and French, with
[next-intl](https://next-intl.dev) and no language prefix in URLs. The language is, in order:
the one chosen in Account (stored in `users.locale`), else the one chosen from the anonymous
profile menu (cookie `kwazat_locale`, also set by the Account choice so it holds after logging
out), else the browser's (`Accept-Language`), else English. Emails follow the same order.
Messages live in `packages/app/messages/<locale>.json`; a test checks that every language has
exactly the English keys and placeholders. Sheet content (statements, Wikidata descriptions and
identity fields) stays in English for now, marked `lang="en"` and announced on French pages;
section titles and relation types are translated. Plan for content: Wikidata labels per language
first, then machine translation of published facts on first view, cached per fact and language.

**Email.** Locally, nothing is sent: messages land in `packages/app/.data/mail` and are shown at
<http://localhost:3000/dev/mail> (development only, readable before login so codes can be
used). Staging and prod have no mail transport yet: sending fails until one is set up.

```bash
pnpm app        # http://localhost:3000, local PGlite database, API keys from Proton Pass (research)
```

Without Proton Pass, `pnpm --filter @kwazat/app dev` runs the same app without API keys:
everything works except research beyond the identity step.

Accounts (stop the app first when using the local database: PGlite allows one process):

```bash
pnpm users add you@example.com          # asks for the password, hidden (12+ characters)
pnpm users password you@example.com     # new password, logs out every session
pnpm users reset-2fa you@example.com    # lost second factor: set up again at next login
pnpm users list
pnpm users remove you@example.com
pnpm users test-account                 # local test account, codes by email (refused with DATABASE_URL)
```

The local test account (`packages/app/test/test-account.ts`) is for automated checks and local
browser testing; it only exists in the local PGlite database.

Limits (`packages/app/src/lib/rate-limit.ts`, in memory, per server process): password checks 5
per minute per client address and 10 per 15 minutes per account; codes typed in 10 per minute
per address; emailed codes one every 30 seconds (the resend button counts down), 5 per hour per
account and 20 per address. Each code allows 5 tries, only the latest code sent works, and 10
second-factor failures lock the account for 15 minutes. The forms call Better Auth from server
actions, which skips its own rate limiter; that one still guards direct calls to `/api/auth`.
Emailed codes are stored hashed. Next.js and Better Auth telemetry are off; the dev server listens on
127.0.0.1 only.

| Setting | Local development | Staging and prod (not deployed yet) |
|---|---|---|
| `BETTER_AUTH_SECRET` | built-in development value | required; Secret Manager |
| `BETTER_AUTH_URL` | `http://localhost:3000` | `https://test.kwazat.fyi`, `https://www.kwazat.fyi` |
| `DATABASE_URL` | unset (PGlite) | Secret Manager (runtime identity) |
| Mail transport | local mailbox | Scaleway Transactional Email from `auth.kwazat.fyi` (to set up) |

