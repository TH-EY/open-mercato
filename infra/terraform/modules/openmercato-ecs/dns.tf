# -----------------------------------------------------------------------------
# ACM certificate
# -----------------------------------------------------------------------------

resource "aws_acm_certificate" "this" {
  count = local.tls_enabled ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Route53 DNS validation records
# -----------------------------------------------------------------------------

resource "aws_route53_record" "validation" {
  for_each = local.tls_enabled ? {
    for dvo in aws_acm_certificate.this[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

# -----------------------------------------------------------------------------
# ACM certificate validation
# -----------------------------------------------------------------------------

resource "aws_acm_certificate_validation" "this" {
  count = local.tls_enabled ? 1 : 0

  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

# -----------------------------------------------------------------------------
# Apex A record -> ALB alias
# -----------------------------------------------------------------------------

resource "aws_route53_record" "app" {
  count = local.tls_enabled ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

# -----------------------------------------------------------------------------
# www CNAME record (optional)
# -----------------------------------------------------------------------------

resource "aws_route53_record" "www" {
  count = local.tls_enabled && var.create_www_record ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = "www.${var.domain_name}"
  type    = "CNAME"
  ttl     = 300
  records = [var.domain_name]
}
