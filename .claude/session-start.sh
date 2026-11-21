#!/usr/bin/env bash
# SessionStart hook: install dependencies in a fresh worktree. Quiet on success, never fails the session.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -d node_modules ] && exit 0
if ! command -v pnpm >/dev/null 2>&1; then
  echo "kwazat: node_modules is missing and pnpm is not on PATH; install pnpm, then run: pnpm install --frozen-lockfile"
  exit 0
fi
if out=$(pnpm install --frozen-lockfile --prefer-offline 2>&1); then
  echo "kwazat: installed dependencies (node_modules was missing)."
else
  echo "kwazat: pnpm install failed; run 'pnpm install --frozen-lockfile' by hand. Last output:"
  echo "$out" | tail -n 15
fi
exit 0
