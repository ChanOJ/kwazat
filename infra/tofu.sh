#!/usr/bin/env bash
# Runs OpenTofu on one stack with the secrets injected from Proton Pass.
# Usage: infra/tofu.sh <stack> <tofu arguments...>
#   infra/tofu.sh shared init
#   infra/tofu.sh shared plan -out=shared.tfplan
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
stack="${1:?usage: infra/tofu.sh <stack> <tofu arguments...>}"
shift
[ -d "$here/$stack" ] || { echo "Unknown stack: $stack" >&2; exit 1; }

exec pass-cli run --env-file "$here/secrets.env" -- tofu -chdir="$here/$stack" "$@"
