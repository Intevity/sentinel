variable "aws_region" {
  description = "AWS region for the update bucket. Must match the S3 backend region in versions.tf."
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = <<-EOT
    Globally-unique S3 bucket name that hosts the public auto-update channel.
    Must NOT contain dots, or the virtual-hosted HTTPS URL
    (https://<bucket>.s3.<region>.amazonaws.com) will fail TLS validation.
  EOT
  type        = string
  default     = "intevity-claude-sentinel-updates"

  validation {
    condition     = !strcontains(var.bucket_name, ".")
    error_message = "bucket_name must not contain dots (breaks the virtual-hosted HTTPS endpoint used by the updater)."
  }
}

variable "s3_prefix" {
  description = "Key prefix made publicly readable and where CI publishes updater artifacts + latest.json. Must match S3_PREFIX in release.yml (stable)."
  type        = string
  default     = "stable"
}

variable "github_owner" {
  description = "GitHub org/user that owns the repo allowed to assume the CI role."
  type        = string
  default     = "Intevity"
}

variable "github_repo" {
  description = "GitHub repo name allowed to assume the CI role."
  type        = string
  default     = "sentinel"
}

variable "github_default_branch" {
  description = "Default branch the scheduled notarize-poll + manual finalize dispatch run on (their OIDC sub is a heads/ ref, not a tags/ ref)."
  type        = string
  default     = "main"
}

variable "create_github_oidc_provider" {
  description = <<-EOT
    Whether to create the GitHub Actions OIDC provider in this account. In a shared
    account it almost always already exists (created by another repo's Terraform), so
    the default references the existing one. Set true ONLY if `terraform plan` reports
    the provider is missing.
  EOT
  type        = bool
  default     = false
}
