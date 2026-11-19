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

# --- DNS zones (kwazat.fyi, kwazat.com) --------------------------------------------------------
# Both domains are registered at Infomaniak and delegated to Scaleway (infra/README.md, DNS).
# The zones exist once the domains are validated; web records come from each environment.

variable "dns_ready_zones" {
  description = "Zones validated in Scaleway (their records are then created), e.g. [\"kwazat.com\"]."
  type        = set(string)
  default     = []
}

variable "proton_mail" {
  description = "True once kwazat.fyi receives mail on Proton: Proton's MX and SPF replace the null MX and `-all`."
  type        = bool
  default     = false
}

variable "proton_dkim" {
  description = "Account part of the DKIM targets in Proton's DKIM tab for kwazat.fyi (protonmail.domainkey.<this>). Set: the three DKIM CNAMEs are published."
  type        = string
  default     = ""
}

locals {
  # kwazat.com never sends or receives mail: refuse anything claiming to come from it.
  # kwazat.fyi moves to Proton Mail (abuse@, syndication@) in two passes: MX and SPF
  # (proton_mail), then DKIM (proton_dkim). DMARC stays p=reject throughout: Proton signs
  # with DKIM and passes SPF (checked on 2026-11-19). Records come from Proton's domain
  # settings and are not secrets.
  fyi_mail = merge(
    var.proton_mail ? {
      "kwazat.fyi mx 10" = { zone = "kwazat.fyi", name = "", type = "MX", data = "mail.protonmail.ch.", priority = 10 }
      "kwazat.fyi mx 20" = { zone = "kwazat.fyi", name = "", type = "MX", data = "mailsec.protonmail.ch.", priority = 20 }
      "kwazat.fyi spf"   = { zone = "kwazat.fyi", name = "", type = "TXT", data = "v=spf1 include:_spf.protonmail.ch ~all", priority = null }
      } : {
      "kwazat.fyi spf"    = { zone = "kwazat.fyi", name = "", type = "TXT", data = "v=spf1 -all", priority = null }
      "kwazat.fyi nullmx" = { zone = "kwazat.fyi", name = "", type = "MX", data = ".", priority = 0 } # RFC 7505
    },
    var.proton_dkim != "" ? {
      "kwazat.fyi dkim 1" = { zone = "kwazat.fyi", name = "protonmail._domainkey", type = "CNAME", data = "protonmail.domainkey.${var.proton_dkim}.", priority = null }
      "kwazat.fyi dkim 2" = { zone = "kwazat.fyi", name = "protonmail2._domainkey", type = "CNAME", data = "protonmail2.domainkey.${var.proton_dkim}.", priority = null }
      "kwazat.fyi dkim 3" = { zone = "kwazat.fyi", name = "protonmail3._domainkey", type = "CNAME", data = "protonmail3.domainkey.${var.proton_dkim}.", priority = null }
    } : {},
    {
      "kwazat.fyi dmarc" = { zone = "kwazat.fyi", name = "_dmarc", type = "TXT", data = "v=DMARC1; p=reject;", priority = null }
    },
  )
  mail_records = { for key, record in merge({
    "kwazat.com spf"    = { zone = "kwazat.com", name = "", type = "TXT", data = "v=spf1 -all", priority = null }
    "kwazat.com dmarc"  = { zone = "kwazat.com", name = "_dmarc", type = "TXT", data = "v=DMARC1; p=reject;", priority = null }
    "kwazat.com nullmx" = { zone = "kwazat.com", name = "", type = "MX", data = ".", priority = 0 } # RFC 7505

    "kwazat.fyi proton verification" = { zone = "kwazat.fyi", name = "", type = "TXT", data = "protonmail-verification=d56a4b853ddf540cb9f1a9ddbeb69c9e30c11ce9", priority = null }
  }, local.fyi_mail) : key => record if contains(var.dns_ready_zones, record.zone) }
}

resource "scaleway_domain_record" "mail" {
  for_each   = local.mail_records
  project_id = data.scaleway_account_project.shared.id
  dns_zone   = each.value.zone
  name       = each.value.name
  type       = each.value.type
  data       = each.value.data
  priority   = each.value.priority
  ttl        = 3600
}

# Renamed from mail_lockdown when kwazat.fyi moved to Proton Mail (2026-11-19).
moved {
  from = scaleway_domain_record.mail_lockdown["kwazat.com spf"]
  to   = scaleway_domain_record.mail["kwazat.com spf"]
}
moved {
  from = scaleway_domain_record.mail_lockdown["kwazat.com dmarc"]
  to   = scaleway_domain_record.mail["kwazat.com dmarc"]
}
moved {
  from = scaleway_domain_record.mail_lockdown["kwazat.com nullmx"]
  to   = scaleway_domain_record.mail["kwazat.com nullmx"]
}
moved {
  from = scaleway_domain_record.mail_lockdown["kwazat.fyi spf"]
  to   = scaleway_domain_record.mail["kwazat.fyi spf"]
}
moved {
  from = scaleway_domain_record.mail_lockdown["kwazat.fyi dmarc"]
  to   = scaleway_domain_record.mail["kwazat.fyi dmarc"]
}
moved {
  from = scaleway_domain_record.mail_lockdown["kwazat.fyi nullmx"]
  to   = scaleway_domain_record.mail["kwazat.fyi nullmx"]
}
