# Staging settings (not secret). `image` is only the image the jobs were created with: later
# images are deployed by the Deploy staging workflow (infra/scripts/deploy-jobs.sh).
image          = "rg.fr-par.scw.cloud/kwazat/researcher@sha256:745e2c7238106876206488205d6d83fc79e1cdc2f3d9b80ca1dc50e938899833" # sha-966642d4b58a
api_keys_ready = true
web_image      = "rg.fr-par.scw.cloud/kwazat/web@sha256:b722dc8f8f8da10f94524633740a759e0af1e9c1841a768d6333e1b31c2353f7" # sha-cea0cc488c89
