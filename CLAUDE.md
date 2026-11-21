# Kwazat: notes for Claude Code sessions

Neutral, sourced fact sheets on public figures and bands (brand/product later). Phase 0: researcher
CLI + a local-only web app. Product overview and "how a sheet is built": [README.md](README.md).
Your global rules (language, push/merge workflow, `.gitignore` baseline) live in `~/Code/CLAUDE.md`
and are not repeated here.

**This repository is public (or will be soon).** Never commit secrets, personal data, e-mails,
local paths, private notes, eval output, or third-party data without a redistribution licence
(`sources/countries.json` is git-ignored and regenerated with `pnpm indices`). Use "Kwazat" in code
and docs (`@kwazat/*`, `KWAZAT_*`, `KwazatBot`); the old name "Waza" must not come back.

## Layout (pnpm workspace, TypeScript, ESM, `tsx`)

| Path | What |
|---|---|
| `packages/db` | Drizzle schema + migrations, Postgres job queue. PGlite locally (`.data/pglite`), Postgres via `DATABASE_URL`. Engine-agnostic: plain Postgres migrations only |
| `packages/researcher` | Wikidata resolution, Claude research/extraction pipeline, severity, CLI (`src/cli.ts`), eval runner, worker |
| `packages/app` | Next.js 16 + Better Auth + next-intl web app (login, signup, search, sheets). Messages in `packages/app/messages` |
| `web` | Static landing site (Caddy image, `web/public`), served on kwazat.fyi |
| `infra` | OpenTofu for Scaleway (`shared`, `envs/staging`, `envs/prod`, `modules/environment`), deploy scripts in `infra/scripts` |
| `playbooks` | One YAML per entity type (`person`, `band`): sections, instructions, schemas. Editing a section makes it stale on every sheet |
| `sources` | Source registry (trusted outlets per country), see `sources/README.md` |
| `eval` | Golden sets per playbook; `eval/reports` is git-ignored |
| `docs` | `infrastructure.md` (design and phases) |

## Commands (run from the repo root)

Free and local:

```bash
pnpm typecheck                              # all packages (app runs `next typegen` first)
pnpm test                                   # all packages, PGlite-backed, no network
pnpm --filter @kwazat/app typecheck         # one package (also: test; @kwazat/researcher, @kwazat/db)
pnpm db:generate                            # new Drizzle migration after editing packages/db/src/schema.ts
pnpm sheet / lookup / sources / trust       # read-only CLI helpers
```

- Commit the generated migration with the schema change. After a migration, restart any running
  dev server (a stale PGlite dir fails with "missing column").
- Researcher tests that hit Wikidata or Claude must stay mocked: tests must not cost money.

**Cost money or need secrets (via `pass-cli`, `secrets.env` holds only `pass://Kwazat/...`
references): never run them without the user's explicit OK, and never from a sandbox:**
`pnpm research`, `pnpm eval`, `pnpm reach`, `pnpm app` (starts the paid research worker), and
anything under `pnpm infra` (`infra/tofu.sh`, which includes `plan`). `pnpm migrate` against a
remote `DATABASE_URL` is deploy territory: ask first. Never touch `infra/envs/prod`, `tofu apply`
or `tofu destroy` on your own.

Local dev server, URLs, ports and seeded accounts: see README section "Local development
(worktrees, URLs, accounts)". Pick a random free port in 3000-4000 when 3000 is taken.

### Testing a change that needs a real research run

Iterating on a section's wording: after one real run, `--frozen-corpus` replays the stored
sources (no planner, no Brave) and only pays notes + extraction; see `docs/research-cost.md`.

Only on the user's word, and say it costs money. Start the app from the worktree you are
changing, in the Terminal panel (keys come from `pass-cli`, so not in your sandbox), on a fresh
DB each time: `KWAZAT_DB_DIR=.data/pglite-checkN pnpm app`, then open the built-in browser on
`/search?q=...`. Check `lsof -iTCP:<port> -sTCP:LISTEN` first and stop stale servers. A worktree's
`.data` may hold fake seed data: don't mix it with real runs.

## CI and deploys (`.github/workflows`)

- `ci.yml` (every PR, and first step of the staging deploy): `pnpm install --frozen-lockfile`,
  `pnpm typecheck`, `pnpm test`, `pnpm --filter @kwazat/app build`; `tofu fmt -check` + `validate`
  of all three stacks + `bash -n` on `infra/**/*.sh`; web image build + Caddy/header checks.
  Run `tofu fmt -recursive infra` (and `pnpm --filter @kwazat/app build` for app changes) before pushing.
- `image.yml`: builds `researcher` and `web` images (amd64), pushed to the Scaleway registry,
  tagged `sha-<12 chars>`.
- `deploy-staging.yml`: every merge to `main` (docs-only changes skipped): CI, image, point the
  jobs at the new digest, run `kwazat-migrate`, free smoke run, deploy web.
- `deploy-prod.yml`: pushing a `v*` tag on a commit already deployed to staging; waits for the
  owner's approval (`production` environment), then promotes the same image digest.
  Tagging is the user's call, never yours.
- CI does not run OpenTofu: infra changes are planned and applied from the user's laptop.

## Git and PRs (repo-specific)

- Auto-merge is disabled on ChanOJ/kwazat (`set_auto_merge` fails). Merging, when the user asks
  for it: wait for `gh pr checks <n>` to be green, then `gh pr merge <n> --merge` (merge
  commits, not squash), then sync local `main`.
- Parallel sessions each work in a worktree under `.claude/worktrees`. `next dev` writes an untracked
  `packages/app/AGENTS.md` (git-ignored): if `git worktree remove` still complains, check
  `git status` before using `--force`.
- Commit author is the GitHub noreply address. Check `git status` before `git add`.

## Product decisions worth knowing

- **Environments** (decided 2026-11-18): dev local (PGlite), staging and prod on Scaleway, one
  project each, same OpenTofu module with different variables, both on Serverless SQL Database in
  phase 0 (move to Managed PostgreSQL together later, staging first). Never propose different
  resource types between staging and prod. Domains: `www.kwazat.fyi` is canonical (bare domain
  and kwazat.com redirect to it), staging is `test.kwazat.fyi`; DNS zones are managed in
  OpenTofu (registrar is only the registrar).
- **Login/signup**: `/login` = email + password, then second factor. `/signup` is its own page
  (email, password twice, live help, then 2FA setup), reached from a "Create account" button on
  `/login` (email and password travel in a 5-minute encrypted cookie limited to `/signup`) and
  from the profile menu. Keep signup on its own URL with `new-password` fields: password managers
  only offer aliases and generators on forms they recognise as signup. Do not merge it back
  into the login screen.
- **Content translation** (decided 2026-11-19): alpha content in English with a French UI is fine;
  machine translation of sensitive sections (convictions, ongoing cases, revelations) is
  acceptable until the end of the beta, to be raised again before public opening. More languages
  come one by one, on request. Plan: Wikidata labels first, then cached LLM translation of
  published facts per (fact, language, source hash); quotes and source titles stay in the
  original language. Don't block features on this.
- **Bands** (entity type `band`, same search box as people):
  - Sheet: identity and members from Wikidata (P527, dates in qualifiers). Research sections
    cover the group itself (`legal_proceedings`, `investigative_revelations`, `controversies`)
    plus `members_conduct` (serious matters of members and the group's reaction
    `group_response`: distanced / supported / no_public_position / unclear). One item per matter;
    keep members' matters out of the group sections and `group_response` structured.
  - Severity icons 🔴🟠🟡◯ follow a legal-status ladder (high: final conviction; medium: charges,
    trial, appeal or investigated allegations; low: civil/reputational; cleared: closed,
    acquitted, overturned). The empty circle is deliberate: green would read as positive.
  - Planned, not built (no score scale yet): `Y_final = Y + P * max(0, X - Y)`, X = member's
    rating, Y = band's own, P from `group_response` (distanced 0, supported 1, no position or
    unclear 0.5, worst matter per member). A per-member weight (frontperson) may come later.
  - Names shown: English Wikipedia title, else Wikidata `mul` label, else `en`.

## Conventions

- Code, comments, docs, commit messages and UI source strings are in English; the UI is localised
  through `packages/app/messages`. Inclusive wording in user-facing strings (see `~/.claude/CLAUDE.md`).
- Shared Claude Code settings are in `.claude/settings.json` (read-only allowlist, auto-install
  hook); personal ones go in the git-ignored `.claude/settings.local.json`.
