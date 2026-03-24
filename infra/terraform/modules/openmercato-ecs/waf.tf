# -----------------------------------------------------------------------------
# WAFv2 Web ACL association (existing ACL only)
# -----------------------------------------------------------------------------

resource "aws_wafv2_web_acl_association" "alb" {
  count = var.waf_mode == "existing" ? 1 : 0

  resource_arn = aws_lb.this.arn
  web_acl_arn  = var.waf_web_acl_arn
}
