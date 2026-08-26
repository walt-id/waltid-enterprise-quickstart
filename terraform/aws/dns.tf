data "aws_route53_zone" "main" {
  count        = var.route53_zone_name != "" ? 1 : 0
  name         = var.route53_zone_name
  private_zone = false
}

resource "aws_route53_record" "ingress" {
  count   = var.route53_zone_name != "" ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.dns_subdomain != "" ? var.dns_subdomain : "@"
  type    = "CNAME"
  ttl     = 60
  records = [local.ingress_lb_hostname]
}

resource "aws_route53_record" "ingress_wildcard" {
  count   = var.route53_zone_name != "" ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.dns_subdomain != "" ? "*.${var.dns_subdomain}" : "*"
  type    = "CNAME"
  ttl     = 60
  records = [local.ingress_lb_hostname]
}
