# -----------------------------------------------------------------------------
# Application Load Balancer
# -----------------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = "${var.name}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.public_subnet_ids

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Target group
# -----------------------------------------------------------------------------

resource "aws_lb_target_group" "web" {
  name        = "${var.name}-web-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 10
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# HTTP listener (no TLS)
# -----------------------------------------------------------------------------

resource "aws_lb_listener" "http" {
  count = local.tls_enabled ? 0 : 1

  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# HTTP -> HTTPS redirect (TLS enabled)
# -----------------------------------------------------------------------------

resource "aws_lb_listener" "http_redirect" {
  count = local.tls_enabled ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# HTTPS listener (TLS enabled)
# -----------------------------------------------------------------------------

resource "aws_lb_listener" "https" {
  count = local.tls_enabled ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  tags = local.common_tags
}
