# -----------------------------------------------------------------------------
# Core
# -----------------------------------------------------------------------------

variable "name" {
  description = "Deployment prefix used for all resource names."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "name must be 2-21 lowercase alphanumeric characters or hyphens, starting with a letter."
  }
}

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
}

variable "image" {
  description = "Full container image reference (including tag or digest) for the OpenMercato app."
  type        = string
}

variable "container_port" {
  description = "Port the OpenMercato container listens on."
  type        = number
  default     = 3000
}

variable "health_check_path" {
  description = "HTTP path for ALB health checks against the web service."
  type        = string
  default     = "/"
}

variable "env" {
  description = "Environment variables for the OpenMercato container. Merged with module-derived values."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Mode selectors
# -----------------------------------------------------------------------------

variable "networking_mode" {
  description = "Whether to create a new VPC (managed) or use existing subnets (existing)."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "existing"], var.networking_mode)
    error_message = "networking_mode must be 'managed' or 'existing'."
  }
}

variable "database_mode" {
  description = "Whether to create a managed RDS instance (managed) or connect to an external database (external)."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "external"], var.database_mode)
    error_message = "database_mode must be 'managed' or 'external'."
  }
}

variable "redis_mode" {
  description = "Whether to create a managed ElastiCache cluster (managed) or connect to an external Redis (external)."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "external"], var.redis_mode)
    error_message = "redis_mode must be 'managed' or 'external'."
  }
}

variable "meilisearch_mode" {
  description = "Whether to run Meilisearch on ECS (managed), connect to external (external), or disable (none)."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "external", "none"], var.meilisearch_mode)
    error_message = "meilisearch_mode must be 'managed', 'external', or 'none'."
  }
}

variable "dns_mode" {
  description = "Whether to create Route53 DNS records and ACM certificate (route53) or skip (none)."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "route53"], var.dns_mode)
    error_message = "dns_mode must be 'none' or 'route53'."
  }
}

variable "runtime_mode" {
  description = "Whether to run a single ECS service (single_service) or split web and workers (split_workers)."
  type        = string
  default     = "split_workers"

  validation {
    condition     = contains(["single_service", "split_workers"], var.runtime_mode)
    error_message = "runtime_mode must be 'single_service' or 'split_workers'."
  }
}

variable "waf_mode" {
  description = "Whether to attach an existing WAFv2 Web ACL to the ALB (existing) or skip (none)."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "existing"], var.waf_mode)
    error_message = "waf_mode must be 'none' or 'existing'."
  }
}

# -----------------------------------------------------------------------------
# Networking - Managed mode
# -----------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the managed VPC."
  type        = string
  default     = "10.1.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (one per AZ, minimum 2)."
  type        = list(string)
  default     = ["10.1.1.0/24", "10.1.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets (one per AZ, minimum 2)."
  type        = list(string)
  default     = ["10.1.10.0/24", "10.1.11.0/24"]
}

# -----------------------------------------------------------------------------
# Networking - Existing mode
# -----------------------------------------------------------------------------

variable "vpc_id" {
  description = "VPC ID when networking_mode is 'existing'."
  type        = string
  default     = null
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for the ALB when networking_mode is 'existing'."
  type        = list(string)
  default     = []
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks, RDS, and ElastiCache when networking_mode is 'existing'."
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Database - Managed mode
# -----------------------------------------------------------------------------

variable "db_engine_version" {
  description = "PostgreSQL engine version for managed RDS."
  type        = string
  default     = "18.3"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage" {
  description = "Allocated storage in GB for the RDS instance."
  type        = number
  default     = 50
}

variable "db_name" {
  description = "Database name for the managed RDS instance."
  type        = string
  default     = "openmercato"
}

variable "db_username" {
  description = "Master username for the managed RDS instance."
  type        = string
  default     = "openmercato"
}

variable "db_deletion_protection" {
  description = "Enable deletion protection for the RDS instance."
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Number of days to retain automated backups."
  type        = number
  default     = 7
}

variable "db_multi_az" {
  description = "Enable Multi-AZ deployment for the RDS instance."
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Database - External mode
# -----------------------------------------------------------------------------

variable "database_url_secret_arn" {
  description = "Secrets Manager ARN containing the full DATABASE_URL when database_mode is 'external'."
  type        = string
  default     = null
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Redis - Managed mode
# -----------------------------------------------------------------------------

variable "redis_deployment_mode" {
  description = "ElastiCache deployment mode: 'replication_group' or 'serverless'."
  type        = string
  default     = "replication_group"

  validation {
    condition     = contains(["replication_group", "serverless"], var.redis_deployment_mode)
    error_message = "redis_deployment_mode must be 'replication_group' or 'serverless'."
  }
}

variable "redis_node_type" {
  description = "ElastiCache node type for replication_group mode."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.1"
}

variable "redis_multi_az" {
  description = "Enable Multi-AZ for the ElastiCache replication group."
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Redis - External mode
# -----------------------------------------------------------------------------

variable "redis_url_secret_arn" {
  description = "Secrets Manager ARN containing the Redis URL when redis_mode is 'external'."
  type        = string
  default     = null
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Meilisearch - Managed mode
# -----------------------------------------------------------------------------

variable "meilisearch_image" {
  description = "Docker image for Meilisearch."
  type        = string
  default     = "getmeili/meilisearch:v1.11"
}

variable "meilisearch_service" {
  description = "Meilisearch ECS service configuration."
  type = object({
    cpu    = optional(number, 512)
    memory = optional(number, 1024)
  })
  default = {}
}

# -----------------------------------------------------------------------------
# Meilisearch - External mode
# -----------------------------------------------------------------------------

variable "meilisearch_host" {
  description = "Meilisearch host URL when meilisearch_mode is 'external'."
  type        = string
  default     = null
}

variable "meilisearch_api_key_secret_arn" {
  description = "Secrets Manager ARN containing the Meilisearch API key when meilisearch_mode is 'external'."
  type        = string
  default     = null
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Web service
# -----------------------------------------------------------------------------

variable "web_service" {
  description = "Web ECS service configuration."
  type = object({
    cpu           = optional(number, 1024)
    memory        = optional(number, 4096)
    desired_count = optional(number, 1)
    command       = optional(list(string), null)
    autoscaling = optional(object({
      min_capacity       = optional(number, 1)
      max_capacity       = optional(number, 6)
      cpu_target         = optional(number, 70)
      memory_target      = optional(number, 80)
      scale_in_cooldown  = optional(number, 300)
      scale_out_cooldown = optional(number, 60)
    }), {})
  })
  default = {}
}

# -----------------------------------------------------------------------------
# Worker services (split_workers mode)
# -----------------------------------------------------------------------------

variable "worker_services" {
  description = "Map of worker service configurations. Each key is a service name."
  type = map(object({
    cpu           = optional(number, 512)
    memory        = optional(number, 1024)
    desired_count = optional(number, 1)
    command       = list(string)
    autoscaling = optional(object({
      min_capacity       = optional(number, 1)
      max_capacity       = optional(number, 4)
      cpu_target         = optional(number, 70)
      memory_target      = optional(number, 80)
      scale_in_cooldown  = optional(number, 300)
      scale_out_cooldown = optional(number, 60)
    }), {})
  }))
  default = {
    worker = {
      command = ["sh", "-c", "yarn mercato queue worker --all"]
    }
  }
}

# -----------------------------------------------------------------------------
# Scheduler sync task (split_workers mode)
# -----------------------------------------------------------------------------

variable "scheduler_sync_task" {
  description = "Optional one-shot scheduler sync task definition."
  type = object({
    enabled = optional(bool, true)
    cpu     = optional(number, 256)
    memory  = optional(number, 512)
    command = optional(list(string), ["sh", "-c", "yarn mercato scheduler start"])
  })
  default = {}
}

# -----------------------------------------------------------------------------
# Secrets (required ARNs)
# -----------------------------------------------------------------------------

variable "jwt_secret_arn" {
  description = "Secrets Manager ARN for JWT_SECRET."
  type        = string
  sensitive   = true
}

variable "encryption_key_secret_arn" {
  description = "Secrets Manager ARN for TENANT_DATA_ENCRYPTION_KEY."
  type        = string
  sensitive   = true
}

# -----------------------------------------------------------------------------
# DNS / TLS
# -----------------------------------------------------------------------------

variable "domain_name" {
  description = "Domain name for the application when dns_mode is 'route53'."
  type        = string
  default     = null
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID when dns_mode is 'route53'."
  type        = string
  default     = null
}

variable "create_www_record" {
  description = "Create a www CNAME record in addition to the apex record."
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# WAF
# -----------------------------------------------------------------------------

variable "waf_web_acl_arn" {
  description = "ARN of an existing WAFv2 Web ACL to associate with the ALB."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# ECR
# -----------------------------------------------------------------------------

variable "create_ecr_repository" {
  description = "Whether to create an ECR repository for the app image."
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------

variable "cpu_architecture" {
  description = "CPU architecture for ECS Fargate tasks. ARM64 uses Graviton (~20% cheaper)."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be 'X86_64' or 'ARM64'."
  }
}

variable "use_public_subnets" {
  description = "Place ECS tasks in public subnets with public IPs (eliminates NAT Gateway cost). Tasks are still protected by security groups."
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log group retention in days."
  type        = number
  default     = 30
}
