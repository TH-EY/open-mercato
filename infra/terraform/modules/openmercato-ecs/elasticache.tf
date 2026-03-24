# -----------------------------------------------------------------------------
# ElastiCache - Managed Redis
# -----------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "this" {
  count = local.create_managed_redis && var.redis_deployment_mode == "replication_group" ? 1 : 0

  name       = "${var.name}-redis"
  subnet_ids = local.private_subnet_ids

  tags = merge(local.common_tags, { Name = "${var.name}-redis" })
}

resource "random_password" "redis_auth_token" {
  count   = local.create_managed_redis ? 1 : 0
  length  = 32
  special = false
}

resource "aws_elasticache_replication_group" "this" {
  count = local.create_managed_redis && var.redis_deployment_mode == "replication_group" ? 1 : 0

  replication_group_id = "${var.name}-redis"
  description          = "Managed Redis for ${var.name}"

  engine         = "redis"
  engine_version = var.redis_engine_version
  node_type      = var.redis_node_type

  num_cache_clusters = var.redis_multi_az ? 2 : 1

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth_token[0].result

  subnet_group_name  = aws_elasticache_subnet_group.this[0].name
  security_group_ids = [aws_security_group.redis[0].id]

  automatic_failover_enabled = var.redis_multi_az
  multi_az_enabled           = var.redis_multi_az

  tags = merge(local.common_tags, { Name = "${var.name}-redis" })
}

resource "aws_elasticache_serverless_cache" "this" {
  count = local.create_managed_redis && var.redis_deployment_mode == "serverless" ? 1 : 0

  engine = "redis"
  name   = "${var.name}-redis-serverless"

  subnet_ids         = local.private_subnet_ids
  security_group_ids = [aws_security_group.redis[0].id]

  tags = merge(local.common_tags, { Name = "${var.name}-redis-serverless" })
}

# -----------------------------------------------------------------------------
# Composed Redis URL secret
# -----------------------------------------------------------------------------

locals {
  # Use static port 6379 for URL composition - ElastiCache uses default port
  # Avoids plan-time null when referencing resource attributes not yet known
  redis_url = (
    local.create_managed_redis
    ? "rediss://:${random_password.redis_auth_token[0].result}@${local.managed_redis_endpoint}:6379"
    : ""
  )
}

resource "aws_secretsmanager_secret" "redis_url" {
  count = local.create_managed_redis ? 1 : 0

  name = "${var.name}/redis-url"

  tags = merge(local.common_tags, { Name = "${var.name}/redis-url" })
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  count = local.create_managed_redis ? 1 : 0

  secret_id     = aws_secretsmanager_secret.redis_url[0].id
  secret_string = local.redis_url
}
