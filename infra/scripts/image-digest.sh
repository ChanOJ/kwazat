#!/usr/bin/env bash
# Prints the digest reference of an image tag:
#   image-digest.sh researcher sha-3a945f50249f -> rg.fr-par.scw.cloud/kwazat/researcher@sha256:...
# Needs SCW_SECRET_KEY with read access to the registry of kwazat-shared.
set -euo pipefail
: "${SCW_SECRET_KEY:?}"
image="${1:?usage: image-digest.sh <image> <tag>}"
tag="${2:?usage: image-digest.sh <image> <tag>}"

API=https://api.scaleway.com/registry/v1/regions/fr-par
call() {
  curl -sS --fail-with-body --retry 4 --retry-connrefused --retry-delay 5 --max-time 30 \
    -H "X-Auth-Token: $SCW_SECRET_KEY" "$@"
}

image_id=$(call "$API/images?name=$image&page_size=10" | jq -r --arg image "$image" '[.images[] | select(.name == $image)][0].id // empty')
[[ -n "$image_id" ]] || { echo "Image $image not found in the registry" >&2; exit 1; }
digest=$(call "$API/images/$image_id/tags?name=$tag" |
  jq -r --arg tag "$tag" '[.tags[] | select(.name == $tag and .status == "ready")][0].digest // empty')
[[ "$digest" == sha256:* ]] || { echo "No ready image tagged $tag" >&2; exit 1; }
echo "rg.fr-par.scw.cloud/kwazat/$image@$digest"
