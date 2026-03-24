# -----------------------------------------------------------------------------
# Mode flags
# -----------------------------------------------------------------------------

locals {
  create_managed_networking  = var.networking_mode == "managed"
  create_managed_rds         = var.database_mode == "managed"
  create_managed_redis       = var.redis_mode == "managed"
  create_managed_meilisearch = var.meilisearch_mode == "managed"
  meilisearch_enabled        = var.meilisearch_mode != "none"
  split_workers              = var.runtime_mode == "split_workers"
  tls_enabled                = var.dns_mode == "route53"
}

# -----------------------------------------------------------------------------
# Networking selectors
# -----------------------------------------------------------------------------

locals {
  vpc_id = local.create_managed_networking ? aws_vpc.this[0].id : var.vpc_id

  public_subnet_ids = local.create_managed_networking ? aws_subnet.public[*].id : var.public_subnet_ids

  private_subnet_ids = local.create_managed_networking ? aws_subnet.private[*].id : var.private_subnet_ids

  az_names = local.create_managed_networking ? data.aws_availability_zones.available[0].names : []
}

# -----------------------------------------------------------------------------
# Service discovery namespace
# -----------------------------------------------------------------------------

locals {
  service_discovery_namespace = "${var.name}.internal"
}

# -----------------------------------------------------------------------------
# Database connection
# -----------------------------------------------------------------------------

locals {
  # Managed RDS: compose DATABASE_URL from RDS outputs
  managed_db_endpoint = local.create_managed_rds ? aws_db_instance.this[0].endpoint : ""
  managed_db_name     = local.create_managed_rds ? aws_db_instance.this[0].db_name : ""
  managed_db_username = local.create_managed_rds ? aws_db_instance.this[0].username : ""
}

# -----------------------------------------------------------------------------
# Redis connection
# -----------------------------------------------------------------------------

locals {
  managed_redis_endpoint = (
    local.create_managed_redis
    ? (
      var.redis_deployment_mode == "replication_group"
      ? aws_elasticache_replication_group.this[0].primary_endpoint_address
      : aws_elasticache_serverless_cache.this[0].endpoint[0].address
    )
    : ""
  )

  managed_redis_port = (
    local.create_managed_redis
    ? (
      var.redis_deployment_mode == "replication_group"
      ? aws_elasticache_replication_group.this[0].port
      : aws_elasticache_serverless_cache.this[0].endpoint[0].port
    )
    : 6379
  )
}

# -----------------------------------------------------------------------------
# Meilisearch connection
# -----------------------------------------------------------------------------

locals {
  meilisearch_host = (
    var.meilisearch_mode == "managed"
    ? "http://meilisearch.${local.service_discovery_namespace}:7700"
    : var.meilisearch_mode == "external"
    ? var.meilisearch_host
    : ""
  )
}

# -----------------------------------------------------------------------------
# Container environment assembly
# -----------------------------------------------------------------------------

locals {
  # Base env shared by all services (web + workers)
  base_env = merge(
    {
      NODE_ENV                   = "production"
      PORT                       = tostring(var.container_port)
      NODE_OPTIONS               = "--max-old-space-size=4096"
      CACHE_STRATEGY             = "redis"
      DB_SSL                     = "true"
      DB_SSL_REJECT_UNAUTHORIZED = "false"
    },
    local.meilisearch_enabled ? {
      MEILISEARCH_HOST = local.meilisearch_host
    } : {},
    var.env,
  )

  # Web-specific env (app-only in split mode)
  web_env = merge(
    local.base_env,
    local.split_workers ? {
      AUTO_SPAWN_WORKERS   = "false"
      AUTO_SPAWN_SCHEDULER = "false"
    } : {},
  )

  # Worker-specific env
  worker_env = merge(
    local.base_env,
    {
      QUEUE_STRATEGY = "async"
    },
  )

  # Secrets injected via ECS secrets block (ARN references)
  base_secrets = merge(
    {
      JWT_SECRET                 = var.jwt_secret_arn
      TENANT_DATA_ENCRYPTION_KEY = var.encryption_key_secret_arn
    },
    local.create_managed_rds ? {
      DATABASE_URL = aws_secretsmanager_secret.database_url[0].arn
    } : {},
    !local.create_managed_rds && var.database_url_secret_arn != null ? {
      DATABASE_URL = var.database_url_secret_arn
    } : {},
    local.create_managed_redis ? {
      CACHE_REDIS_URL = aws_secretsmanager_secret.redis_url[0].arn
    } : {},
    !local.create_managed_redis && var.redis_url_secret_arn != null ? {
      CACHE_REDIS_URL = var.redis_url_secret_arn
    } : {},
    local.create_managed_meilisearch ? {
      MEILISEARCH_API_KEY = aws_secretsmanager_secret.meilisearch_api_key[0].arn
    } : {},
    !local.create_managed_meilisearch && var.meilisearch_api_key_secret_arn != null ? {
      MEILISEARCH_API_KEY = var.meilisearch_api_key_secret_arn
    } : {},
  )

  # Common tags
  common_tags = merge(
    {
      Project   = "openmercato"
      ManagedBy = "terraform"
      Module    = "openmercato-ecs"
    },
    var.tags,
  )
}
