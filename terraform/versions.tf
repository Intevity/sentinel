terraform {
  # use_lockfile (S3-native state locking) requires Terraform >= 1.10 — no DynamoDB
  # lock table needed. If your other repos lock via DynamoDB on intevity-si, that's a
  # separate mechanism and does not conflict with the per-key .tflock object used here.
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # State lives in the shared intevity-si bucket under a repo-namespaced key.
  # Backend blocks cannot use variables, so region is a literal — it must match the
  # region intevity-si actually lives in (us-east-1).
  backend "s3" {
    bucket       = "intevity-si"
    key          = "claude-sentinel/updates/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
