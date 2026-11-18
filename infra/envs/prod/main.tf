variable "state_passphrase" {
  description = "Passphrase of the state encryption (Proton Pass: vault Kwazat, item tofu-state-passphrase)."
  type        = string
  sensitive   = true
}

variable "image" {
  description = "Researcher image by digest, from the image workflow. Empty until the first build."
  type        = string
  default     = ""
}

variable "api_keys_ready" {
  description = "Set to true once ANTHROPIC_API_KEY and BRAVE_SEARCH_API_KEY have a version in Secret Manager."
  type        = bool
  default     = false
}

variable "database_url_version" {
  description = "Bump (with -replace of the database API keys) to rotate the database credentials."
  type        = number
  default     = 1
}

# Created by infra/shared.
data "scaleway_account_project" "prod" {
  name = "kwazat-prod"
}

data "scaleway_account_project" "shared" {
  name = "kwazat-shared"
}

module "environment" {
  source              = "../../modules/environment"
  env                 = "prod"
  project_id          = data.scaleway_account_project.prod.id
  registry_project_id = data.scaleway_account_project.shared.id
  image               = var.image
  api_keys_ready      = var.api_keys_ready
  database_max_cpu    = 2

  database_url_version = var.database_url_version
}

output "environment" {
  value     = module.environment
  sensitive = true
}

output "ci_deploy_secret_key" {
  value     = module.environment.ci_deploy_secret_key
  sensitive = true
}

output "project_id" {
  value = data.scaleway_account_project.prod.id
}
