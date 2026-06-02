# GitHub Actions OIDC provider. Referenced by default (shared account usually already
# has it); created only when create_github_oidc_provider = true.
data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS no longer verifies the thumbprint for this issuer (it uses its own trust store),
  # but the API still requires a non-empty value.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  github_oidc_provider_arn = (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : data.aws_iam_openid_connect_provider.github[0].arn
  )

  # The publish-updates job assumes this role from three trigger contexts, so the trust
  # policy must allow all of them:
  #   - tag pushes (release.yml on v* tags)                  -> ref:refs/tags/*
  #   - the scheduled notarize-poll workflow (long-tail S3)  -> ref:refs/heads/<default>
  #   - manual notarize-finalize dispatch (S3 republish)     -> ref:refs/heads/<default>
  # The latter two run on the default branch, so their OIDC sub is a heads/ ref, not a
  # tags/ ref. Allowing the default branch is the same trust class (only repo maintainers
  # can push tags or run workflows on the default branch), and the role grants nothing
  # beyond s3:PutObject on the update prefix.
  github_oidc_subjects = [
    "repo:${var.github_owner}/${var.github_repo}:ref:refs/tags/*",
    "repo:${var.github_owner}/${var.github_repo}:ref:refs/heads/${var.github_default_branch}",
  ]
}

data "aws_iam_policy_document" "ci_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_oidc_subjects
    }
  }
}

resource "aws_iam_role" "ci_publish" {
  name               = "claude-sentinel-updates-publisher"
  description        = "GitHub Actions role to publish Claude Sentinel auto-update artifacts to S3"
  assume_role_policy = data.aws_iam_policy_document.ci_assume.json
}

# Least privilege: the workflow uses `aws s3 cp` (uploads only), which needs PutObject
# and nothing else — no ListBucket, no delete, scoped to the published prefix.
data "aws_iam_policy_document" "ci_publish" {
  statement {
    sid       = "PutUpdateArtifacts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.updates.arn}/${var.s3_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "ci_publish" {
  name   = "publish-updates"
  role   = aws_iam_role.ci_publish.id
  policy = data.aws_iam_policy_document.ci_publish.json
}
