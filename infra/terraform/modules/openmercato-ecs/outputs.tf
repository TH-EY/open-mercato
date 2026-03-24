# -----------------------------------------------------------------------------
# Load Balancer
# -----------------------------------------------------------------------------

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer."
  value       = aws_lb.this.dns_name
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer."
  value       = aws_lb.this.arn
}

# -----------------------------------------------------------------------------
# ECS
# -----------------------------------------------------------------------------

output "cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ARN of the ECS cluster."
  value       = aws_ecs_cluster.this.arn
}

output "web_service_name" {
  description = "Name of the web ECS service."
  value       = aws_ecs_service.web.name
}

output "worker_service_names" {
  description = "Map of worker service names."
  value       = { for k, v in aws_ecs_service.worker : k => v.name }
}

# -----------------------------------------------------------------------------
# Database
# -----------------------------------------------------------------------------

output "database_endpoint" {
  description = "RDS instance endpoint (managed mode only)."
  value       = local.create_managed_rds ? aws_db_instance.this[0].endpoint : null
}

# -----------------------------------------------------------------------------
# Redis
# -----------------------------------------------------------------------------

output "redis_endpoint" {
  description = "ElastiCache primary endpoint (managed mode only)."
  value       = local.create_managed_redis ? local.managed_redis_endpoint : null
}

# -----------------------------------------------------------------------------
# Meilisearch
# -----------------------------------------------------------------------------

output "meilisearch_service_discovery_name" {
  description = "Cloud Map service discovery hostname for Meilisearch."
  value       = local.create_managed_meilisearch ? "meilisearch.${local.service_discovery_namespace}" : null
}

# -----------------------------------------------------------------------------
# Application URL
# -----------------------------------------------------------------------------

output "application_url" {
  description = "Primary application URL (custom domain if configured, otherwise ALB DNS)."
  value       = local.tls_enabled ? "https://${var.domain_name}" : "http://${aws_lb.this.dns_name}"
}

# -----------------------------------------------------------------------------
# ECR
# -----------------------------------------------------------------------------

output "ecr_repository_url" {
  description = "ECR repository URL (if created)."
  value       = var.create_ecr_repository ? aws_ecr_repository.app[0].repository_url : null
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

output "vpc_id" {
  description = "VPC ID (managed or existing)."
  value       = local.vpc_id
}

# -----------------------------------------------------------------------------
# Scheduler
# -----------------------------------------------------------------------------

output "scheduler_sync_task_definition_arn" {
  description = "ARN of the scheduler sync task definition (split_workers mode)."
  value       = local.split_workers && var.scheduler_sync_task.enabled ? aws_ecs_task_definition.scheduler_sync[0].arn : null
}
