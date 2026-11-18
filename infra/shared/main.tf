variable "state_passphrase" {
  description = "Passphrase of the state encryption (Proton Pass: vault Kwazat, item tofu-state-passphrase)."
  type        = string
  sensitive   = true
}

# Created by hand during the bootstrap: it holds the state bucket this stack depends on.
data "scaleway_account_project" "shared" {
  name = "kwazat-shared"
}

# One project per environment: IAM permissions, secrets and billing stay apart, so a staging
# credential cannot touch prod. Their content is managed by infra/envs/<env>.
resource "scaleway_account_project" "env" {
  for_each = {
    staging = "Kwazat staging: deployed on every merge to main."
    prod    = "Kwazat production: deployed on version tags after approval."
  }

  name        = "kwazat-${each.key}"
  description = each.value
}

# Images are built once per commit and promoted from staging to prod by digest.
resource "scaleway_registry_namespace" "kwazat" {
  name        = "kwazat"
  description = "Kwazat images, shared by staging and prod."
  project_id  = data.scaleway_account_project.shared.id
  region      = "fr-par"
  is_public   = false
}

output "shared_project_id" {
  value = data.scaleway_account_project.shared.id
}

output "project_ids" {
  value = { for env, project in scaleway_account_project.env : env => project.id }
}

output "registry_endpoint" {
  value = scaleway_registry_namespace.kwazat.endpoint
}
