# Infrastructure plan — Scaleway

Status: **proposal** (2026-11-18). Nothing described here exists yet.

## Goals

- Three environments: **dev** (local), **staging** and **prod** (Scaleway).
- Staging behaves like prod: same resource types, same OpenTofu module, only sizes and
  retention differ.
- Everything on Scaleway is described in OpenTofu in this repository and can be rebuilt from it.
- No secret value in the repository or in OpenTofu state in clear text.
- Phase 0 only deploys what exists: the database and the researcher CLI as a batch job. The web
  app will be added to the same layout later.

## Environments

| | Dev | Staging | Prod |
|---|---|---|---|
| Runs on | Developer machine | Scaleway project `kwazat-staging` | Scaleway project `kwazat-prod` |
| Database | PGlite (embedded, `.data/pglite`) | Serverless SQL Database | Serverless SQL Database |
| Secrets | Proton Pass via `secrets.env` | Secret Manager (staging) | Secret Manager (prod) |
| Anthropic key | `dev` key, own workspace + spend limit | `staging` key, own workspace + spend limit | `prod` key, own workspace + spend limit |
| Hostname | — | `staging.kwazat.fyi` | `kwazat.fyi` |
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

Secret **values** are written by hand (Scaleway console or `scw` CLI) once; OpenTofu only
declares the secrets and grants access, so values never enter the state.

## DNS

Infomaniak stays the **registrar only**. Both zones are delegated to Scaleway and managed in
OpenTofu (`infra/shared`), so records live next to the resources they point to.

| Record | Target |
|---|---|
| `kwazat.fyi`, `www.kwazat.fyi` | Prod web app (later); placeholder page until then |
| `staging.kwazat.fyi` | Staging web app (later) |
| `kwazat.com`, `www.kwazat.com` | Permanent redirect to `https://kwazat.fyi` |

- `.fyi` is not on the HSTS preload list by default: the web layer sends
  `Strict-Transport-Security` and redirects HTTP to HTTPS; preload submission once stable.
- `security.txt` points to `abuse@kwazat.fyi`. One source file kept next to `robots.txt`, served
  at `/security.txt` and at `/.well-known/security.txt` (the location RFC 9116 requires).
- How the apex redirect of `kwazat.com` is served (Edge Services or a tiny redirect container)
  is decided in phase 5.

## Mail (later phase)

Hosted on Proton Mail (custom domain on the existing Proton Family plan).

- `kwazat.fyi`: addresses `abuse@` (RFC 2142) and `syndication@` (contact for publishers, shown
  on the KwazatBot page). MX, SPF, DKIM and DMARC records come from Proton's domain settings and
  go into OpenTofu (they are not secrets).
- `kwazat.com` never sends mail: null MX (`0 .`), SPF `v=spf1 -all`, DMARC `p=reject`, so
  nobody can send convincing mail "from Kwazat" through it.

## Repository layout

```
infra/
  bootstrap/README.md      Manual one-off steps (state bucket, first API key)
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

Credentials: one GitHub environment per Scaleway environment (`staging`, `production`), each
holding only that project's deploy API key. If Scaleway supports OIDC federation with GitHub
Actions when this is implemented, use it instead of long-lived keys.

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
| 1 | Bootstrap | Projects, state bucket and CI API keys exist; `infra/shared` applies from a laptop |
| 2 | Staging | Database, secrets and jobs in staging; `research --identity-only` runs there |
| 3 | CI/CD | Merge to `main` deploys staging without a laptop |
| 4 | Prod | A `v*` tag deploys prod after approval |
| 5 | DNS | Zones delegated to Scaleway; `kwazat.com` redirects; placeholder page and `security.txt` (both paths) on HTTPS |
| 6 | Mail | `abuse@` and `syndication@` receive mail; `kwazat.com` anti-spoofing records published |

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
- In Proton: add `kwazat.fyi` as a custom domain and create the addresses (phase 6).

## Open questions

- Monthly budget thresholds for the staging and prod billing alerts.
- Should prod run research on a schedule, or only on demand, during phase 0?
