terraform {
  required_version = ">= 1.11.0" # write-only attributes

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.92"
    }
  }

  # Same bucket and encryption as infra/shared (backends cannot come from a module).
  backend "s3" {
    bucket = "kwazat-tofu-state"
    key    = "prod/terraform.tfstate"
    region = "fr-par"
    endpoints = {
      s3 = "https://s3.fr-par.scw.cloud"
    }
    # Native locking through conditional writes (If-None-Match), supported by Scaleway.
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  # Client-side encryption: the bucket only ever holds encrypted state and plans.
  encryption {
    key_provider "pbkdf2" "passphrase" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.passphrase
    }
    state {
      method   = method.aes_gcm.main
      enforced = true
    }
    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }
}

provider "scaleway" {
  # Credentials and organisation from SCW_ACCESS_KEY, SCW_SECRET_KEY and
  # SCW_DEFAULT_ORGANIZATION_ID (infra/secrets.env).
  region = "fr-par"
  zone   = "fr-par-1"
}
