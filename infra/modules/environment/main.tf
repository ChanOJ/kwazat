# Everything one Kwazat environment needs in its own Scaleway project. Staging and prod call this
# module with different sizes only, so staging behaves like prod (see docs/infrastructure.md).

terraform {
  required_providers {
    scaleway = {
      source = "scaleway/scaleway"
    }
  }
}

variable "env" {
  description = "Environment name: staging or prod."
  type        = string
}

variable "project_id" {
  description = "Scaleway project of the environment (created by infra/shared)."
  type        = string
}

variable "registry_project_id" {
  description = "Project kwazat-shared: holds the image registry (CI must read it to deploy an image) and the DNS zones."
  type        = string
}

variable "web_image" {
  description = "Image the web container is created with (rg.fr-par.scw.cloud/kwazat/web@sha256:...). Empty: no web container yet. Later images are deployed by CI."
  type        = string
  default     = ""
}

variable "web_domains" {
  description = "Hostnames served by the web container, keyed by hostname: DNS zone and record name (empty name = zone apex)."
  type        = map(object({ zone = string, name = string }))
  default     = {}
}

variable "dns_ready" {
  description = "True once the zones of web_domains are validated in Scaleway: records and custom domains are then created."
  type        = bool
  default     = false
}

variable "image" {
  description = "Image the jobs are created with (rg.fr-par.scw.cloud/kwazat/researcher@sha256:...). Empty: no jobs yet. Later images are deployed by CI (infra/scripts/deploy-jobs.sh), not by OpenTofu."
  type        = string
  default     = ""
}

variable "api_keys_ready" {
  description = "True once the Anthropic and Brave secrets have a version (entered by hand): the research job then receives them."
  type        = bool
  default     = false
}

variable "database_max_cpu" {
  description = "Upper bound of the Serverless SQL autoscaling, in vCPU."
  type        = number
}

variable "database_url_version" {
  description = "Bump to rewrite the DATABASE_URL secrets (after rotating the database API keys)."
  type        = number
  default     = 1
}

locals {
  region = "fr-par"
  # Third-party keys: declared here, values entered by hand so they never enter the state.
  api_keys = {
    ANTHROPIC_API_KEY    = "Anthropic API key of the kwazat-${var.env} workspace (spend-limited)."
    BRAVE_SEARCH_API_KEY = "Brave Search API key."
  }
}

# --- Database ------------------------------------------------------------------------------

resource "scaleway_sdb_sql_database" "main" {
  name       = "kwazat"
  project_id = var.project_id
  region     = local.region
  min_cpu    = 0
  max_cpu    = var.database_max_cpu
}

# Two identities: `migrate` may change the schema (run once per deploy), `runtime` only reads and
# writes data, so a research job cannot alter the database structure.
locals {
  database_roles = {
    migrate = "ServerlessSQLDatabaseReadWrite"
    runtime = "ServerlessSQLDatabaseDataReadWrite"
  }
}

resource "scaleway_iam_application" "database" {
  for_each    = local.database_roles
  name        = "kwazat-${var.env}-${each.key}"
  description = "Kwazat ${var.env}: database access for ${each.key} jobs."
}

resource "scaleway_iam_policy" "database" {
  for_each       = local.database_roles
  name           = "kwazat-${var.env}-${each.key}"
  description    = "Kwazat ${var.env}: ${each.value} on the ${var.env} project only."
  application_id = scaleway_iam_application.database[each.key].id
  rule {
    project_ids          = [var.project_id]
    permission_set_names = [each.value]
  }
}

# Serverless SQL logs in with the application id as user and an API key secret as password.
resource "scaleway_iam_api_key" "database" {
  for_each           = local.database_roles
  application_id     = scaleway_iam_application.database[each.key].id
  default_project_id = var.project_id
  description        = "Kwazat ${var.env}: ${each.key} database login."

  # Scaleway sets a one-year expiry on its own. Rotate before it: `tofu apply -replace=...` on
  # these keys with `database_url_version` bumped (see infra/README.md, "Key expiry").
  lifecycle {
    ignore_changes = [expires_at]
  }
}

resource "scaleway_secret" "database_url" {
  for_each    = local.database_roles
  name        = each.key == "runtime" ? "DATABASE_URL" : "DATABASE_URL_MIGRATE"
  description = "Kwazat ${var.env}: connection string of the ${each.key} identity."
  project_id  = var.project_id
  region      = local.region
}

# Write-only: the connection string is sent to Secret Manager but not kept in the state.
resource "scaleway_secret_version" "database_url" {
  for_each        = local.database_roles
  secret_id       = scaleway_secret.database_url[each.key].id
  region          = local.region
  data_wo_version = var.database_url_version
  data_wo = replace(
    scaleway_sdb_sql_database.main.endpoint,
    "postgres://",
    "postgres://${scaleway_iam_application.database[each.key].id}:${scaleway_iam_api_key.database[each.key].secret_key}@",
  )
}

# --- Third-party API keys --------------------------------------------------------------------

resource "scaleway_secret" "api_key" {
  for_each    = local.api_keys
  name        = each.key
  description = each.value
  project_id  = var.project_id
  region      = local.region
}

# --- CI deployment ---------------------------------------------------------------------------

# Used by GitHub Actions to point the jobs at a new image and run them. It cannot touch IAM,
# secrets or the database directly (the jobs read their secrets on their own).
resource "scaleway_iam_application" "ci_deploy" {
  name        = "kwazat-ci-deploy-${var.env}"
  description = "Kwazat CI: deploys images to the ${var.env} jobs."
}

resource "scaleway_iam_policy" "ci_deploy" {
  name           = "kwazat-ci-deploy-${var.env}"
  description    = "Kwazat CI: Serverless Jobs and Containers on the ${var.env} project, registry read on kwazat-shared."
  application_id = scaleway_iam_application.ci_deploy.id
  rule {
    project_ids          = [var.project_id]
    permission_set_names = ["ServerlessJobsFullAccess", "ContainersFullAccess"]
  }
  # Scaleway checks that the image exists when a job definition changes image.
  rule {
    project_ids          = [var.registry_project_id]
    permission_set_names = ["ContainerRegistryReadOnly"]
  }
}

resource "scaleway_iam_api_key" "ci_deploy" {
  application_id     = scaleway_iam_application.ci_deploy.id
  default_project_id = var.project_id
  description        = "Kwazat CI: deploys to ${var.env} (GitHub environment ${var.env})."

  # Scaleway sets a one-year expiry on its own (see infra/README.md, "Key expiry").
  lifecycle {
    ignore_changes = [expires_at]
  }
}

# --- Jobs ------------------------------------------------------------------------------------

resource "scaleway_job_definition" "migrate" {
  count = var.image == "" ? 0 : 1
  # Scaleway refuses a job whose secret has no version yet.
  depends_on = [scaleway_secret_version.database_url]

  name                   = "kwazat-migrate"
  description            = "Applies pending database migrations. Run once per deploy, before the other jobs."
  project_id             = var.project_id
  region                 = local.region
  image_uri              = var.image
  args                   = ["migrate"]
  cpu_limit              = 500
  memory_limit           = 512
  local_storage_capacity = 1024
  timeout                = "10m"

  # No automatic retry: a migration or a paid research run is never replayed silently.
  retry_policy {
    max_retries = 0
  }

  # The image is deployed by CI after each merge (infra/scripts/deploy-jobs.sh).
  lifecycle {
    ignore_changes = [image_uri]
  }

  secret_reference {
    secret_id   = scaleway_secret.database_url["migrate"].id
    environment = "DATABASE_URL"
  }
}

resource "scaleway_job_definition" "researcher" {
  count = var.image == "" ? 0 : 1
  # Scaleway refuses a job whose secret has no version yet.
  depends_on = [scaleway_secret_version.database_url]

  name                   = "kwazat-researcher"
  description            = "Researcher CLI. Default arguments: free identity-only smoke run; override them per run."
  project_id             = var.project_id
  region                 = local.region
  image_uri              = var.image
  args                   = ["research", "Q57751", "--identity-only"]
  cpu_limit              = 1000
  memory_limit           = 2048
  local_storage_capacity = 1024
  timeout                = "1h"

  # No automatic retry: a migration or a paid research run is never replayed silently.
  retry_policy {
    max_retries = 0
  }

  # The image is deployed by CI after each merge (infra/scripts/deploy-jobs.sh).
  lifecycle {
    ignore_changes = [image_uri]
  }

  secret_reference {
    secret_id   = scaleway_secret.database_url["runtime"].id
    environment = "DATABASE_URL"
  }

  dynamic "secret_reference" {
    for_each = var.api_keys_ready ? local.api_keys : {}
    content {
      secret_id   = scaleway_secret.api_key[secret_reference.key].id
      environment = secret_reference.key
    }
  }
}

# --- Web front -------------------------------------------------------------------------------

resource "scaleway_container_namespace" "web" {
  name        = "kwazat-web"
  description = "Kwazat ${var.env}: web front."
  project_id  = var.project_id
  region      = local.region
}

resource "scaleway_container" "web" {
  count                  = var.web_image == "" ? 0 : 1
  name                   = "web"
  description            = "Kwazat ${var.env}: waiting page, robots.txt and security.txt (web/), later the web app."
  namespace_id           = scaleway_container_namespace.web.id
  image                  = var.web_image
  port                   = 8080
  cpu_limit              = 140
  memory_limit_bytes     = 268000000 # Scaleway stores memory in decimal megabytes (268 MB)
  min_scale              = 0
  max_scale              = 2
  privacy                = "public"
  https_connections_only = true
  environment_variables = {
    KWAZAT_ENV = var.env == "prod" ? "prod" : "test"
  }

  # The image is deployed by CI after each merge (infra/scripts/deploy-web.sh).
  lifecycle {
    ignore_changes = [image]
  }
}

locals {
  web_host = length(scaleway_container.web) == 0 ? "" : trimsuffix(trimprefix(scaleway_container.web[0].public_endpoint, "https://"), "/")
  # Records and custom domains need both the container and validated zones.
  web_domains = var.dns_ready && local.web_host != "" ? var.web_domains : {}
}

# Apex names use ALIAS (a CNAME is not allowed there), other names CNAME.
resource "scaleway_domain_record" "web" {
  for_each   = local.web_domains
  project_id = var.registry_project_id
  dns_zone   = each.value.zone
  name       = each.value.name
  type       = each.value.name == "" ? "ALIAS" : "CNAME"
  data       = "${local.web_host}."
  ttl        = 300
}

resource "scaleway_container_domain" "web" {
  for_each     = local.web_domains
  container_id = scaleway_container.web[0].id
  hostname     = each.key
  region       = local.region
  depends_on   = [scaleway_domain_record.web]
}

output "web_endpoint" {
  value = local.web_host
}

output "database_endpoint" {
  value = scaleway_sdb_sql_database.main.endpoint
}

output "api_key_secret_ids" {
  description = "Secrets whose values are entered by hand (Secret Manager > secret > Add version)."
  value       = { for name, secret in scaleway_secret.api_key : name => secret.id }
}

output "job_definition_ids" {
  value = {
    migrate    = one(scaleway_job_definition.migrate[*].id)
    researcher = one(scaleway_job_definition.researcher[*].id)
  }
}

output "ci_deploy_secret_key" {
  value     = scaleway_iam_api_key.ci_deploy.secret_key
  sensitive = true
}
