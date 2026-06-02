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

  # The publish-updates job only runs on tag pushes (release.yml triggers on v* tags),
  # so the role is assumable solely from this repo's tag refs. Broaden to
  # "repo:owner/repo:*" if you ever publish from a branch or manual dispatch.
  github_oidc_subject = "repo:${var.github_owner}/${var.github_repo}:ref:refs/tags/*"
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
      values   = [local.github_oidc_subject]
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
