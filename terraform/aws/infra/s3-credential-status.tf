resource "aws_s3_bucket" "credential_status" {
  count = var.enable_credential_status_bucket ? 1 : 0

  bucket        = "${var.cluster_name}-credential-status-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.credential_status_force_destroy

  tags = merge(local.common_tags, {
    Name    = "${var.cluster_name}-credential-status"
    Purpose = "credential-status"
  })
}

resource "aws_s3_bucket_versioning" "credential_status" {
  count = var.enable_credential_status_bucket && var.credential_status_versioning_enabled ? 1 : 0

  bucket = aws_s3_bucket.credential_status[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "credential_status" {
  count = var.enable_credential_status_bucket && var.credential_status_versioning_enabled && var.credential_status_lifecycle_enabled ? 1 : 0

  bucket = aws_s3_bucket.credential_status[0].id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = var.credential_status_noncurrent_version_expiration_days
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "credential_status" {
  count = var.enable_credential_status_bucket ? 1 : 0

  bucket = aws_s3_bucket.credential_status[0].id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.credential_status_cors_allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "credential_status_bucket_policy" {
  count = var.enable_credential_status_bucket ? 1 : 0

  # Allow public read access for credential verification
  statement {
    sid    = "PublicReadAccess"
    effect = "Allow"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:GetObject"
    ]

    resources = [
      "${aws_s3_bucket.credential_status[0].arn}/*"
    ]
  }

  # Require TLS for all requests
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.credential_status[0].arn,
      "${aws_s3_bucket.credential_status[0].arn}/*"
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_public_access_block" "credential_status" {
  count = var.enable_credential_status_bucket ? 1 : 0

  bucket = aws_s3_bucket.credential_status[0].id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "credential_status" {
  count = var.enable_credential_status_bucket ? 1 : 0

  bucket = aws_s3_bucket.credential_status[0].id
  policy = data.aws_iam_policy_document.credential_status_bucket_policy[0].json

  depends_on = [aws_s3_bucket_public_access_block.credential_status]
}

resource "aws_iam_user" "credential_status" {
  count = var.enable_credential_status_bucket ? 1 : 0

  name = "${var.cluster_name}-credential-status-user"

  tags = merge(local.common_tags, {
    Name    = "${var.cluster_name}-credential-status-user"
    Purpose = "credential-status"
  })
}

data "aws_iam_policy_document" "credential_status_user_policy" {
  count = var.enable_credential_status_bucket ? 1 : 0

  statement {
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.credential_status[0].arn,
      "${aws_s3_bucket.credential_status[0].arn}/*",
    ]
  }
}

resource "aws_iam_user_policy" "credential_status" {
  count = var.enable_credential_status_bucket ? 1 : 0

  name   = "${var.cluster_name}-credential-status-policy"
  user   = aws_iam_user.credential_status[0].name
  policy = data.aws_iam_policy_document.credential_status_user_policy[0].json
}

resource "aws_iam_access_key" "credential_status" {
  count = var.enable_credential_status_bucket ? 1 : 0

  user = aws_iam_user.credential_status[0].name
}
