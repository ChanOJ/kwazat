#!/usr/bin/env bash
# Deploys an image to the Kwazat jobs of one environment, then checks it:
#   1. points kwazat-migrate and kwazat-researcher at the image (by digest);
#   2. runs kwazat-migrate and waits for it;
#   3. runs kwazat-researcher with its default arguments (free identity-only smoke run).
#
# Environment:
#   SCW_SECRET_KEY  API key allowed to manage the environment's jobs (CI deploy identity)
#   SCW_PROJECT_ID  Scaleway project of the environment
#   IMAGE           rg.fr-par.scw.cloud/kwazat/researcher@sha256:...
#
# Network hiccups are retried (reads and image updates are idempotent); a job that fails is
# reported at once. A run interrupted by the platform is started once more.
set -euo pipefail

: "${SCW_SECRET_KEY:?}" "${SCW_PROJECT_ID:?}" "${IMAGE:?}"
[[ "$IMAGE" == *@sha256:* ]] || { echo "IMAGE must be a digest reference: $IMAGE" >&2; exit 1; }

API=https://api.scaleway.com/serverless-jobs/v1alpha1/regions/fr-par
RUN_TIMEOUT_S=900

# Idempotent calls: retried on refused connections, timeouts, 429 and 5xx (not on 4xx: a
# refused key or a bad request is a real failure).
call() {
  curl -sS --fail-with-body --retry 4 --retry-connrefused --retry-delay 5 --max-time 30 \
    -H "X-Auth-Token: $SCW_SECRET_KEY" -H "Content-Type: application/json" "$@"
}

job_id() {
  local id
  id=$(call "$API/job-definitions?project_id=$SCW_PROJECT_ID&page_size=100" |
    jq -r --arg name "$1" '.job_definitions[] | select(.name == $name) | .id')
  [[ -n "$id" ]] || { echo "Job definition $1 not found in project $SCW_PROJECT_ID" >&2; exit 1; }
  echo "$id"
}

# Starts a run and waits for its end. Not retried automatically: starting twice would run twice.
run_job() {
  local name=$1 id=$2 attempt run state out
  for attempt in 1 2; do
    run=$(curl -sS --fail-with-body --max-time 30 -X POST -H "X-Auth-Token: $SCW_SECRET_KEY" \
      -H "Content-Type: application/json" -d '{}' "$API/job-definitions/$id/start" | jq -r '.job_runs[0].id')
    echo "$name: run $run started"
    local waited=0
    while :; do
      sleep 10
      waited=$((waited + 10))
      out=$(call "$API/job-runs/$run")
      state=$(jq -r '.state' <<<"$out")
      case "$state" in
        succeeded)
          echo "$name: succeeded"
          return 0
          ;;
        interrupted)
          echo "$name: interrupted by the platform ($(jq -r '.error_message // "-"' <<<"$out"))" >&2
          break
          ;;
        failed | canceled)
          echo "$name: $state: $(jq -r '.error_message // "no message"' <<<"$out") (exit code $(jq -r '.exit_code // "-"' <<<"$out"))" >&2
          echo "Logs: Scaleway console > project > Serverless Jobs > $name > run $run" >&2
          exit 1
          ;;
      esac
      if ((waited >= RUN_TIMEOUT_S)); then
        echo "$name: still $state after $RUN_TIMEOUT_S s (run $run)" >&2
        exit 1
      fi
    done
  done
  echo "$name: interrupted twice, giving up" >&2
  exit 1
}

migrate=$(job_id kwazat-migrate)
researcher=$(job_id kwazat-researcher)

for id in "$migrate" "$researcher"; do
  call -X PATCH -d "$(jq -n --arg image "$IMAGE" '{image_uri: $image}')" "$API/job-definitions/$id" >/dev/null
done
for id in "$migrate" "$researcher"; do
  current=$(call "$API/job-definitions/$id" | jq -r '.image_uri')
  [[ "$current" == "$IMAGE" ]] || { echo "Job $id still runs $current" >&2; exit 1; }
done
echo "Jobs now run $IMAGE"

run_job kwazat-migrate "$migrate"
run_job kwazat-researcher "$researcher"
