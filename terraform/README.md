# Terraform: Claude Sentinel auto-update channel

Provisions the public S3 bucket that hosts macOS auto-update artifacts (`*.app.tar.gz`,
`*.sig`, `latest.json`) plus the GitHub Actions **OIDC role** the release workflow assumes
to publish them. No long-lived AWS keys are created.

## What it creates

- **S3 bucket** (`intevity-claude-sentinel-updates` by default) — ACLs disabled
  (`BucketOwnerEnforced`), SSE-S3, with a bucket policy granting **anonymous `s3:GetObject`
  on the `stable/*` prefix only**. The compiled binaries are public; nothing else in the
  bucket is, and the source repo stays private.
- **IAM role** (`claude-sentinel-updates-publisher`) — assumable only via GitHub OIDC from
  this repo's **tag** pushes, with `s3:PutObject` on `stable/*` and nothing more.

State is stored in the shared **`intevity-si`** bucket under
`claude-sentinel/updates/terraform.tfstate`, locked with S3-native locking
(`use_lockfile`, no DynamoDB table).

## Prerequisites

- Terraform **>= 1.10** (for `use_lockfile`).
- AWS credentials for an account principal allowed to create S3 buckets + IAM roles
  (e.g. `aws sso login` / an admin profile). Set `AWS_PROFILE`/`AWS_REGION` or use your
  usual auth before running.

## Usage

```sh
cd terraform
terraform init      # configures the intevity-si backend
terraform plan      # review
terraform apply
```

If `plan` errors that the GitHub OIDC provider does not exist, set
`create_github_oidc_provider = true` (in `terraform.tfvars`) and re-run.

## After apply

`terraform output` prints the four repo variables to set. The `gh_cli_setup` output is
copy/paste-ready:

```sh
terraform output -raw gh_cli_setup | sh   # or run the printed lines manually
```

That sets `S3_BUCKET`, `AWS_REGION`, `UPDATER_PUBLIC_BASE`, and `AWS_ROLE_ARN` as repo
**variables**. With OIDC there are **no** AWS secrets to store. Once set, the next `v*`
tag publishes signed updater artifacts to the bucket and the in-app updater goes live.

> Bucket names are global and must not contain dots (a dotted name breaks the
> virtual-hosted HTTPS endpoint the updater uses). Override `bucket_name` if the default
> is taken.
