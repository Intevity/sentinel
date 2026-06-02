resource "aws_s3_bucket" "updates" {
  bucket = var.bucket_name
}

# ACLs disabled — access is governed solely by the prefix-scoped bucket policy below.
resource "aws_s3_bucket_ownership_controls" "updates" {
  bucket = aws_s3_bucket.updates.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Allow the public *policy* (the updater needs anonymous GET) while still blocking
# any ACL-based public access. block_public_policy/restrict_public_buckets must be
# false or the PutBucketPolicy below is rejected.
resource "aws_s3_bucket_public_access_block" "updates" {
  bucket                  = aws_s3_bucket.updates.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

# SSE-S3 (AES256), NOT SSE-KMS: anonymous GET works transparently with AES256, whereas
# KMS would require the anonymous principal to hold kms:Decrypt and break public reads.
resource "aws_s3_bucket_server_side_encryption_configuration" "updates" {
  bucket = aws_s3_bucket.updates.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Public read for ONLY the published prefix (stable/*). The rest of the bucket — and
# any future private prefixes — stay unreadable to the world.
data "aws_iam_policy_document" "public_read" {
  statement {
    sid    = "PublicReadUpdateArtifacts"
    effect = "Allow"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.updates.arn}/${var.s3_prefix}/*"]
  }
}

resource "aws_s3_bucket_policy" "updates" {
  bucket = aws_s3_bucket.updates.id
  policy = data.aws_iam_policy_document.public_read.json

  # Must apply after the public-access block is relaxed, else PutBucketPolicy fails.
  depends_on = [aws_s3_bucket_public_access_block.updates]
}
