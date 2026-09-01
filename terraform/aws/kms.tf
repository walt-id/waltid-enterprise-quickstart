resource "aws_iam_user" "kms" {
  count = var.enable_kms_key_manager ? 1 : 0

  name = "${var.cluster_name}-kms-user"

  tags = merge(local.common_tags, {
    Name    = "${var.cluster_name}-kms-user"
    Purpose = "kms"
  })
}

data "aws_iam_policy_document" "kms_user_policy" {
  count = var.enable_kms_key_manager ? 1 : 0

  statement {
    effect = "Allow"
    actions = [
      "kms:CreateKey",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:UpdateAlias",
      "kms:DescribeKey",
      "kms:GetPublicKey",
      "kms:ListKeys",
      "kms:ListAliases",
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:Sign",
      "kms:Verify",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_user_policy" "kms" {
  count = var.enable_kms_key_manager ? 1 : 0

  name   = "${var.cluster_name}-kms-policy"
  user   = aws_iam_user.kms[0].name
  policy = data.aws_iam_policy_document.kms_user_policy[0].json
}

resource "aws_iam_access_key" "kms" {
  count = var.enable_kms_key_manager ? 1 : 0

  user = aws_iam_user.kms[0].name
}
