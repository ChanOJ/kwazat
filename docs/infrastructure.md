# Infrastructure plan — Scaleway

Status (2026-11-19): phases 1 to 5 done — `infra/shared`, staging and prod are applied; every
merge to `main` deploys staging, and a `v*` tag promotes the same image to prod after approval
(first release, v0.1.0: 2026-11-18). `www.kwazat.fyi` (canonical), `kwazat.fyi`, `kwazat.com`,
`www.kwazat.com` and `test.kwazat.fyi` are served over HTTPS since 2026-11-19, and kwazat.fyi
receives mail on Proton Mail (phase 6, see "Mail"). All six phases are done.

## Goals

- Three environments: **dev** (local), **staging** and **prod** (Scaleway).
- Staging behaves like prod: same resource types, same OpenTofu module, only sizes and
  retention differ.
- Everything on Scaleway is described in OpenTofu in this repository and can be rebuilt from it.
- No secret value in the repository or in OpenTofu state in clear text.
- Phase 0 only deploys what exists: the database and the researcher CLI as a batch job. The web
  app will be added to the same layout later.

## Web app (not deployed yet)

The web app (`packages/app`, Next.js + Better Auth, login-gated, see README "Web app") runs
locally only since 2026-11-19; `test.kwazat.fyi` and `www.kwazat.fyi` still serve the Caddy
waiting page. Deploying it is a separate change: a Node image for `packages/app` in place of (or
behind) the Caddy container, keeping its security headers, redirects, `robots.txt` and
`security.txt`; a `BETTER_AUTH_SECRET` secret per environment and `DATABASE_URL` (runtime
identity) for the container; `BETTER_AUTH_URL` per environment; the client IP forwarded by
Scaleway trusted for login rate limiting; and the owner's account created with
`DATABASE_URL=... pnpm users add` against each database.

## Environments

| | Dev | Staging | Prod |
|---|---|---|---|
| Runs on | Developer machine | Scaleway project `kwazat-staging` | Scaleway project `kwazat-prod` |
| Database | PGlite (embedded, `.data/pglite`) | Serverless SQL Database | Serverless SQL Database |
| Secrets | Proton Pass via `secrets.env` | Secret Manager (staging) | Secret Manager (prod) |
| Anthropic key | `dev` key, own workspace + spend limit | `staging` key, own workspace + spend limit | `prod` key, own workspace + spend limit |
| Hostname | — | `test.kwazat.fyi` | `www.kwazat.fyi` |
| Deployed by | — | GitHub Actions on merge to `main` | GitHub Actions on a `v*` tag, after manual approval |

**Database engine.** Both Scaleway environments use Serverless SQL Database during phase 0:
there is no steady traffic and it bills usage rather than uptime. When the web app brings
steady traffic, **both** move to Managed PostgreSQL in the same change, staging first as a
rehearsal. Staging and prod never run different engines.

## Scaleway organisation layout

The three projects live in the owner's existing professional organisation; a dedicated organisation is only needed if Kwazat becomes a separate legal entity. The organisation ID is passed as a CI variable, not committed. Region `fr-par` for everything.

| Project | Holds | Managed by |
|---|---|---|
| `kwazat-shared` | OpenTofu state bucket, Container Registry namespace, DNS zones `kwazat.fyi` and `kwazat.com` | Bootstrap (by hand) + `infra/shared` |
| `kwazat-staging` | Staging database, secrets, jobs, (later) containers | Project created by `infra/shared`, content by `infra/envs/staging` |
| `kwazat-prod` | Prod database, secrets, jobs, (later) containers | Project created by `infra/shared`, content by `infra/envs/prod` |

One project per environment isolates IAM permissions, secrets and billing: a staging credential
cannot touch prod.

**Images are built once.** CI builds one image per commit, pushes it to the shared registry
tagged with the commit SHA, deploys it to staging, and promotes **the same digest** to prod.
Prod never runs an image that staging has not run.

## Resources per environment (module `infra/modules/environment`)

| Resource | Purpose | Staging vs prod |
|---|---|---|
| Serverless SQL Database | Kwazat database | Lower CPU cap in staging; longer backup retention in prod |
| Secret Manager secrets | `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY`, `DATABASE_URL` | Different values, same names |
| Serverless Jobs definition `researcher` | Runs the CLI (`research`, `eval`, `indices`) on demand or on a schedule | Same image digest |
| Serverless Job `migrate` | Applies Drizzle migrations before each deploy | Same |
| IAM application `kwazat-<env>-runtime` | Identity of the jobs, reads only its project's secrets and database | Same policy, own project |
| IAM application `kwazat-<env>-deploy` | Used by CI to deploy into that project only | Same policy, own project |
| Cockpit | Logs and metrics of jobs | Shorter retention in staging |
| Billing alert | Email when monthly spend crosses a threshold | Lower threshold in staging |

Third-party secret **values** (Anthropic, Brave) are written by hand once; OpenTofu only
declares those secrets, so their values never enter the state. Database credentials are
generated by OpenTofu: the API keys are in the encrypted state, and the connection strings are
written to Secret Manager as write-only values. Database access is split between a `migrate`
identity (schema changes) and a `runtime` identity (data only). See infra/README.md.

## DNS

Infomaniak stays the **registrar only**. Both zones are delegated to Scaleway and managed in
OpenTofu (`infra/shared`), so records live next to the resources they point to.

| Record | Target |
|---|---|
| `www.kwazat.fyi` | Prod web app (later); placeholder page until then. Canonical host |
| `kwazat.fyi` | Permanent redirect to `https://www.kwazat.fyi` |
| `test.kwazat.fyi` | Staging web app (later), not indexed |
| `kwazat.com`, `www.kwazat.com` | Permanent redirect to `https://www.kwazat.fyi` |

- `.fyi` is not on the HSTS preload list by default: the web layer sends
  `Strict-Transport-Security` and redirects HTTP to HTTPS; preload submission once stable.
- `security.txt` points to the abuse contact (see "Mail"). One source file kept next to `robots.txt`, served
  at `/security.txt` and at `/.well-known/security.txt` (the location RFC 9116 requires).
- How the apex redirect of `kwazat.com` is served (Edge Services or a tiny redirect container)
  is decided in phase 5.

## Mail

`kwazat.fyi` is on Proton Mail (owner's Proton plan) since 2026-11-19:

| Contact | Address | Shown in |
|---|---|---|
| Abuse and security (RFC 2142) | `abuse@kwazat.fyi` | `security.txt`, `SECURITY.md` |
| Syndication (publishers, e.g. those refusing bots) | `syndication@kwazat.fyi` | the KwazatBot page, when it exists |

Its records (verification TXT, MX, SPF, DKIM, DMARC `p=reject`) come from Proton's domain
settings and live in `infra/shared` (they are not secrets). DMARC moved from `p=quarantine` to
`p=reject` on 2026-11-19, once mail from the domain was seen passing DKIM and SPF.

`kwazat.com` sends and receives no mail: null MX (`0 .`), SPF `v=spf1 -all` and DMARC
`p=reject`, so nobody can send convincing mail "from Kwazat" through it.

From 2026-11-19 until Proton was set up, the contacts were Proton Pass aliases; they may stay
active as forwarding addresses but are no longer published.

## Repository security (GitHub settings, set on 2026-11-19)

Not in code, so listed here. The repository is public, which makes these free:

- secret scanning with **push protection** (a push containing a known key format is refused);
  generic patterns and validity checks need the paid Secret Protection and stay off;
- Dependabot alerts and security updates, plus grouped monthly updates of GitHub Actions and
  Docker images (`.github/dependabot.yml`; npm gets security updates only);
- CodeQL default setup (TypeScript and GitHub Actions workflows), not a required check yet;
- private vulnerability reporting, referenced by `SECURITY.md` and the `Policy:` line of
  `security.txt`;
- ruleset on `main`: pull request required, checks `code`, `infra` and `web` required, no force
  push or deletion; environments `staging` (from `main`) and `production` (`v*` tags, owner
  approval).

## Repository layout

```
infra/
  bootstrap/README.md      Manual one-off steps (state bucket, first API key)
  secrets.env              Proton Pass references for OpenTofu (no values)
  tofu.sh                  Runs a stack with those secrets: `pnpm infra <stack> <command>`
  modules/environment/     Everything one environment needs (database, secrets, jobs, IAM)
  shared/                  Registry, DNS zones and records
  envs/staging/            Module call with staging variables
  envs/prod/               Module call with prod variables
Dockerfile                 Researcher image (Node 22, pnpm workspace, production deps)
.github/workflows/
  ci.yml                   Typecheck + `tofu fmt -check` + `tofu validate` on every PR
  deploy.yml               Build, push, migrate, deploy staging; promote to prod on tag
```

## OpenTofu state

- Backend: S3-compatible bucket in `kwazat-shared` (Scaleway Object Storage), versioning on,
  one state file per stack (`shared`, `staging`, `prod`).
- **OpenTofu client-side state encryption** on every stack, so the bucket only ever holds
  encrypted state. The passphrase is in Proton Pass (vault `Kwazat`, item `tofu-state-passphrase`)
  for local runs and in a GitHub Actions secret for CI.
- Provider and OpenTofu versions pinned; `.terraform.lock.hcl` committed.

## CI/CD (GitHub Actions)

1. **Pull request** — `pnpm typecheck`, `tofu fmt -check`, `tofu validate`, `tofu plan` for
   staging posted as a job summary. No apply.
2. **Merge to `main`** — build the image, push it as `sha-<commit>`, `tofu apply` staging, run
   the `migrate` job, run a smoke job (`research <known entity> --identity-only`, no paid API).
3. **Tag `v*`** — GitHub environment `production` with required approval by the owner;
   `tofu apply` prod with the digest already deployed to staging, `migrate`, smoke job.

Credentials: one deploy identity per Scaleway environment, limited to that project's jobs plus
registry read (`kwazat-ci-deploy-<env>`), and a registry-only push identity. CI deploys by
pointing the jobs at the new digest through the API (`infra/scripts/deploy-jobs.sh`); it does
not run OpenTofu, which would need organisation-wide IAM rights. The repository is public, so
GitHub environments are available: each deploy key is an environment secret
(`SCW_DEPLOY_SECRET_KEY` of `staging`, later `production` with required approval), readable
only by jobs of that environment from `main`. Plans on pull requests (step 1) are left for
later.

Checks follow the repository rule on false alarms: the smoke job and DNS/HTTPS checks retry
with backoff to absorb propagation delays, and fail immediately on a real error (non-2xx
after retries, wrong content, failed migration).

## Code changes needed

1. `packages/db`: `openDb()` uses a regular Postgres driver when `DATABASE_URL` is set, and PGlite
   otherwise (dev, eval). Migrations stay plain Postgres SQL generated by Drizzle; nothing
   specific to Serverless SQL.
2. Migrations move out of `openDb()` into a `migrate` command, run once per deploy, not at every
   job start.
3. `sources/countries.json` is git-ignored but needed at runtime: the image build runs
   `pnpm indices` (or the `researcher` job does it on a schedule and stores the result).
   Licences of these indices must be checked before they are served publicly.
4. `Dockerfile` for the researcher.

## Phases

| # | Phase | Done when |
|---|---|---|
| 1 | Bootstrap | Shared project, state bucket and operator key exist; `infra/shared` applies from a laptop and creates the staging and prod projects and the registry |
| 2 | Staging | Database, secrets and jobs in staging; `research --identity-only` runs there |
| 3 | CI/CD | CI keys, one per project, exist; merge to `main` deploys staging without a laptop |
| 4 | Prod | A `v*` tag deploys prod after approval |
| 5 | DNS | Zones delegated to Scaleway; `kwazat.com` redirects; placeholder page and `security.txt` (both paths) on HTTPS |
| 6 | Mail | `abuse@` and `syndication@kwazat.fyi` receive mail; contacts moved from the aliases |

## Manual steps (owner)

Detailed click paths will be written in `infra/bootstrap/README.md` when each phase starts:

- Create the `kwazat-shared` project and the first API key used to bootstrap (phase 1); the
  staging and prod projects are then created by OpenTofu.
- Enter secret values in Secret Manager for staging and prod (phase 2).
- Create the `staging` and `prod` Anthropic keys, each in its own workspace with a spend limit
  (phase 2).
- Create the GitHub environments and the `production` approval rule (phase 3).
- At Infomaniak: add the Scaleway validation TXT record, then switch name servers to
  `ns0.dom.scw.cloud` / `ns1.dom.scw.cloud` (phase 5).
- In Proton: add `kwazat.fyi` as a custom domain and create the addresses (phase 6, once a
  custom-domain slot is free).

## Open questions

- Monthly budget thresholds for the staging and prod billing alerts.
- Should prod run research on a schedule, or only on demand, during phase 0?
