# Prod settings (not secret). `image` is only the image the jobs were created with: later images
# are promoted from staging by the Deploy prod workflow on a version tag (infra/README.md).
image          = "rg.fr-par.scw.cloud/kwazat/researcher@sha256:c4fb8be6b683461fa0de464559926d574b0834535e8405302859a175bcd7a605" # sha-3a945f50249f, deployed to staging
api_keys_ready = true
web_image      = "rg.fr-par.scw.cloud/kwazat/web@sha256:b722dc8f8f8da10f94524633740a759e0af1e9c1841a768d6333e1b31c2353f7" # sha-cea0cc488c89
