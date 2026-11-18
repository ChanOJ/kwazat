#!/usr/bin/env bash
# Deploys a web image to the `web` container of one environment, then checks it over HTTPS.
#
# Environment:
#   SCW_SECRET_KEY  API key allowed to manage the environment's containers (CI deploy identity)
#   SCW_PROJECT_ID  Scaleway project of the environment
#   WEB_IMAGE       rg.fr-par.scw.cloud/kwazat/web@sha256:...
#   WEB_URL         optional public URL (https://test.kwazat.fyi): checked too when set
#
# Until OpenTofu has created the container (infra/README.md, DNS), it is skipped with a warning.
# The checks retry for a few minutes (cold start, propagation of a new revision) and then fail.
set -euo pipefail

: "${SCW_SECRET_KEY:?}" "${SCW_PROJECT_ID:?}" "${WEB_IMAGE:?}"
[[ "$WEB_IMAGE" == *@sha256:* ]] || { echo "WEB_IMAGE must be a digest reference: $WEB_IMAGE" >&2; exit 1; }

API=https://api.scaleway.com/containers/v1beta1/regions/fr-par
DEPLOY_TIMEOUT_S=300
CHECK_ATTEMPTS=18 # x 10 s

# Idempotent calls: retried on refused connections, timeouts, 429 and 5xx (not on 4xx).
call() {
  curl -sS --fail-with-body --retry 4 --retry-connrefused --retry-delay 5 --max-time 30 \
    -H "X-Auth-Token: $SCW_SECRET_KEY" -H "Content-Type: application/json" "$@"
}

namespace=$(call "$API/namespaces?project_id=$SCW_PROJECT_ID&page_size=100" |
  jq -r '[.namespaces[] | select(.name == "kwazat-web") | .id] | join(" ")')
container=""
if [[ -n "$namespace" && "$namespace" != *" "* ]]; then
  container=$(call "$API/containers?namespace_id=$namespace&page_size=100" |
    jq -r '[.containers[] | select(.name == "web") | .id] | join(" ")')
fi
if [[ -z "$container" ]]; then
  echo "::warning::No web container in project $SCW_PROJECT_ID yet: web deploy skipped (see infra/README.md, DNS)"
  exit 0
fi
[[ "$container" != *" "* ]] || { echo "Several web containers ($container): keep the one in the OpenTofu state" >&2; exit 1; }

call -X PATCH -d "$(jq -n --arg image "$WEB_IMAGE" '{registry_image: $image, redeploy: true}')" \
  "$API/containers/$container" >/dev/null
echo "web: deploying $WEB_IMAGE"

waited=0
while :; do
  sleep 10
  waited=$((waited + 10))
  out=$(call "$API/containers/$container")
  status=$(jq -r '.status' <<<"$out")
  case "$status" in
    ready)
      [[ "$(jq -r '.registry_image' <<<"$out")" == "$WEB_IMAGE" ]] ||
        { echo "web: ready but still on $(jq -r '.registry_image' <<<"$out")" >&2; exit 1; }
      break
      ;;
    pending | creating | created | upgrading | locking | locked) ;;
    error)
      echo "web: deploy failed: $(jq -r '.error_message // "no message"' <<<"$out")" >&2
      exit 1
      ;;
    *)
      echo "web: unexpected status '$status'" >&2
      exit 1
      ;;
  esac
  ((waited < DEPLOY_TIMEOUT_S)) || { echo "web: still $status after $DEPLOY_TIMEOUT_S s" >&2; exit 1; }
done
endpoint="https://$(jq -r '.domain_name' <<<"$out")"
echo "web: ready at $endpoint"

# Fails at the first wrong answer once the site responds; retries only while it does not.
check_site() {
  local base=$1 attempt page headers
  for attempt in $(seq 1 "$CHECK_ATTEMPTS"); do
    if page=$(curl -sS --fail --max-time 20 "$base/" 2>/dev/null); then
      break
    fi
    ((attempt < CHECK_ATTEMPTS)) || { echo "$base/ still unreachable after $((CHECK_ATTEMPTS * 10)) s" >&2; exit 1; }
    sleep 10
  done
  grep -q "<title>Kwazat</title>" <<<"$page" || { echo "$base/ does not serve the Kwazat page" >&2; exit 1; }
  for path in /.well-known/security.txt /security.txt; do
    curl -sS --fail --max-time 20 --retry 3 "$base$path" | grep -q "^Contact: " ||
      { echo "$base$path has no Contact line" >&2; exit 1; }
  done
  headers=$(curl -sS --fail --max-time 20 --retry 3 -o /dev/null -D - "$base/")
  grep -qi "^strict-transport-security:" <<<"$headers" || { echo "$base/ sends no HSTS header" >&2; exit 1; }
  echo "web: $base checked (page, security.txt at both paths, HSTS)"
}

check_site "$endpoint"
if [[ -n "${WEB_URL:-}" ]]; then
  check_site "${WEB_URL%/}"
fi
