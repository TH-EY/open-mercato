# -----------------------------------------------------------------------------
# ALB security group
# -----------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Security group for the Application Load Balancer."
  vpc_id      = local.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.name}-alb"
  })
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "Allow HTTP from internet."
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "Allow HTTPS from internet."
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "Allow all outbound traffic."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# App (ECS tasks) security group
# -----------------------------------------------------------------------------

resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "Security group for ECS application tasks."
  vpc_id      = local.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.name}-app"
  })
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "Allow traffic from ALB on container port."
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.alb.id

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "Allow all outbound traffic."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# RDS security group (managed database only)
# -----------------------------------------------------------------------------

resource "aws_security_group" "db" {
  count = local.create_managed_rds ? 1 : 0

  name        = "${var.name}-db"
  description = "Security group for managed RDS instance."
  vpc_id      = local.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.name}-db"
  })
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  count = local.create_managed_rds ? 1 : 0

  security_group_id            = aws_security_group.db[0].id
  description                  = "Allow PostgreSQL from app tasks."
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Redis security group (managed Redis only)
# -----------------------------------------------------------------------------

resource "aws_security_group" "redis" {
  count = local.create_managed_redis ? 1 : 0

  name        = "${var.name}-redis"
  description = "Security group for managed ElastiCache Redis."
  vpc_id      = local.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.name}-redis"
  })
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  count = local.create_managed_redis ? 1 : 0

  security_group_id            = aws_security_group.redis[0].id
  description                  = "Allow Redis from app tasks."
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Meilisearch security group (managed Meilisearch only)
# -----------------------------------------------------------------------------

resource "aws_security_group" "meilisearch" {
  count = local.create_managed_meilisearch ? 1 : 0

  name        = "${var.name}-meilisearch"
  description = "Security group for managed Meilisearch ECS task."
  vpc_id      = local.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.name}-meilisearch"
  })
}

resource "aws_vpc_security_group_ingress_rule" "meilisearch_from_app" {
  count = local.create_managed_meilisearch ? 1 : 0

  security_group_id            = aws_security_group.meilisearch[0].id
  description                  = "Allow Meilisearch API from app tasks."
  from_port                    = 7700
  to_port                      = 7700
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id

  tags = local.common_tags
}

resource "aws_vpc_security_group_egress_rule" "meilisearch_all" {
  count = local.create_managed_meilisearch ? 1 : 0

  security_group_id = aws_security_group.meilisearch[0].id
  description       = "Allow all outbound traffic."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# EFS security group
# -----------------------------------------------------------------------------

resource "aws_security_group" "efs" {
  name        = "${var.name}-efs"
  description = "Security group for EFS (Meilisearch data and app storage)."
  vpc_id      = local.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.name}-efs"
  })
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_meilisearch" {
  count = local.create_managed_meilisearch ? 1 : 0

  security_group_id            = aws_security_group.efs.id
  description                  = "Allow NFS from Meilisearch task."
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.meilisearch[0].id

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_app" {
  security_group_id            = aws_security_group.efs.id
  description                  = "Allow NFS from app tasks."
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id

  tags = local.common_tags
}
