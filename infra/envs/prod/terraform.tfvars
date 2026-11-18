# Prod settings (not secret). `image` is only the image the jobs were created with: later images
# are promoted from staging by the Deploy prod workflow on a version tag (infra/README.md).
image          = "rg.fr-par.scw.cloud/kwazat/researcher@sha256:c4fb8be6b683461fa0de464559926d574b0834535e8405302859a175bcd7a605" # sha-3a945f50249f, deployed to staging
api_keys_ready = true
