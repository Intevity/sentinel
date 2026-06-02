output "bucket_name" {
  description = "Set as the S3_BUCKET repo variable."
  value       = aws_s3_bucket.updates.bucket
}

output "aws_region" {
  description = "Set as the AWS_REGION repo variable."
  value       = var.aws_region
}

output "updater_public_base" {
  description = "Set as the UPDATER_PUBLIC_BASE repo variable. The updater endpoint baked into the binary becomes <this>/stable/latest.json."
  value       = "https://${aws_s3_bucket.updates.bucket}.s3.${var.aws_region}.amazonaws.com"
}

output "ci_role_arn" {
  description = "Set as the AWS_ROLE_ARN repo variable (assumed by release.yml via OIDC)."
  value       = aws_iam_role.ci_publish.arn
}

output "gh_cli_setup" {
  description = "Copy/paste to configure the repo variables from these outputs."
  value       = <<-EOT
    gh variable set S3_BUCKET --body "${aws_s3_bucket.updates.bucket}"
    gh variable set AWS_REGION --body "${var.aws_region}"
    gh variable set UPDATER_PUBLIC_BASE --body "https://${aws_s3_bucket.updates.bucket}.s3.${var.aws_region}.amazonaws.com"
    gh variable set AWS_ROLE_ARN --body "${aws_iam_role.ci_publish.arn}"
  EOT
}
