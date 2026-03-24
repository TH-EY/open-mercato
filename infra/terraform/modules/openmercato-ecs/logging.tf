# -----------------------------------------------------------------------------
# Web service log group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name}/web"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Name = "/ecs/${var.name}/web"
  })
}

# -----------------------------------------------------------------------------
# Worker service log groups (split_workers mode)
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "worker" {
  for_each = local.split_workers ? var.worker_services : {}

  name              = "/ecs/${var.name}/worker-${each.key}"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Name = "/ecs/${var.name}/worker-${each.key}"
  })
}

# -----------------------------------------------------------------------------
# Meilisearch log group (managed Meilisearch only)
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "meilisearch" {
  count = local.create_managed_meilisearch ? 1 : 0

  name              = "/ecs/${var.name}/meilisearch"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Name = "/ecs/${var.name}/meilisearch"
  })
}

# -----------------------------------------------------------------------------
# Scheduler sync log group (split_workers mode, when enabled)
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "scheduler_sync" {
  count = local.split_workers && var.scheduler_sync_task.enabled ? 1 : 0

  name              = "/ecs/${var.name}/scheduler-sync"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Name = "/ecs/${var.name}/scheduler-sync"
  })
}
