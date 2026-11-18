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

# CI identity that pushes images to the registry, and nothing else. Its secret key goes to the
# GitHub Actions secret SCW_REGISTRY_SECRET_KEY (see infra/bootstrap/README.md).
resource "scaleway_iam_application" "ci_registry" {
  name        = "kwazat-ci-registry"
  description = "Kwazat CI: pushes images to the kwazat registry."
}

resource "scaleway_iam_policy" "ci_registry" {
  name           = "kwazat-ci-registry"
  description    = "Kwazat CI: write access to the registry of the kwazat-shared project only."
  application_id = scaleway_iam_application.ci_registry.id
  rule {
    project_ids          = [data.scaleway_account_project.shared.id]
    permission_set_names = ["ContainerRegistryFullAccess"]
  }
}

resource "scaleway_iam_api_key" "ci_registry" {
  application_id     = scaleway_iam_application.ci_registry.id
  default_project_id = data.scaleway_account_project.shared.id
  description        = "Kwazat CI: registry push (GitHub Actions)."

  # Scaleway sets a one-year expiry on its own (see infra/README.md, "Key expiry").
  lifecycle {
    ignore_changes = [expires_at]
  }
}

output "ci_registry_secret_key" {
  value     = scaleway_iam_api_key.ci_registry.secret_key
  sensitive = true
}
