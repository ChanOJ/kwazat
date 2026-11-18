# Researcher image: the CLI of packages/researcher, run by Scaleway Serverless Jobs.
# Built once per commit by CI (linux/amd64) and promoted from staging to prod by digest.
# Usage: docker run <image> <command> [args...], e.g. `migrate` or `research Q57751 --identity-only`.
FROM node:26-slim

# Same pnpm as package.json `packageManager` (corepack is no longer shipped with Node).
RUN npm install --global pnpm@12.18.0 && npm cache clean --force

WORKDIR /app

# Dependencies first, so that code changes reuse this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/researcher/package.json packages/researcher/
RUN pnpm install --frozen-lockfile && pnpm store prune

COPY packages packages
COPY playbooks playbooks
COPY sources sources
COPY eval/golden eval/golden

# Country indices are not committed (third-party data, see sources/README.md): fetched at build
# time so that the registry can load. The image stays private.
RUN pnpm --filter @kwazat/researcher indices

# Files the CLI may write at run time (access list, trust snapshot, eval reports).
RUN mkdir -p eval/reports && chown -R node:node sources eval
USER node

ENV NODE_ENV=production
ENTRYPOINT ["/app/node_modules/.bin/tsx", "/app/packages/researcher/src/cli.ts"]
