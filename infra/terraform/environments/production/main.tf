provider "aws" {
  region = "eu-west-2"

  default_tags {
    tags = {
      Environment = "production"
      Project     = "openmercato"
      ManagedBy   = "terraform"
    }
  }
}

module "openmercato" {
  source = "../../modules/openmercato-ecs"

  name       = "openmercato"
  aws_region = "eu-west-2"
  image      = var.image

  # --- Modes ---
  networking_mode  = "managed"
  database_mode    = "managed"
  redis_mode       = "managed"
  meilisearch_mode = "managed"
  dns_mode         = var.domain_name != null ? "route53" : "none"
  runtime_mode     = "split_workers"

  # --- Networking (managed, cost-optimized: public subnets, no NAT) ---
  vpc_cidr             = "10.1.0.0/16"
  public_subnet_cidrs  = ["10.1.1.0/24", "10.1.2.0/24"]
  private_subnet_cidrs = ["10.1.10.0/24", "10.1.11.0/24"]
  use_public_subnets   = true

  # --- Database ---
  db_engine_version        = "18.3"
  db_instance_class        = var.db_instance_class
  db_allocated_storage     = var.db_allocated_storage
  db_name                  = "openmercato"
  db_username              = "openmercato"
  db_deletion_protection   = true
  db_backup_retention_days = 7
  db_multi_az              = var.db_multi_az

  # --- Redis ---
  redis_deployment_mode = "replication_group"
  redis_node_type       = var.redis_node_type
  redis_engine_version  = "7.1"

  # --- Meilisearch (cost-optimized) ---
  meilisearch_service = {
    cpu    = 256
    memory = 512
  }

  # --- Web service ---
  web_service = {
    cpu           = 512
    memory        = 2048
    desired_count = var.web_desired_count
    command       = ["/bin/sh", "/app/docker/scripts/railway-entrypoint.sh"]
    autoscaling = {
      min_capacity = var.web_min_capacity
      max_capacity = var.web_max_capacity
    }
  }

  # --- Worker services (cost-optimized) ---
  worker_services = {
    worker = {
      cpu           = 256
      memory        = 512
      desired_count = var.worker_desired_count
      command       = ["sh", "-c", "yarn mercato queue worker --all"]
      autoscaling = {
        min_capacity = 1
        max_capacity = var.worker_max_capacity
      }
    }
  }

  # --- Secrets ---
  jwt_secret_arn            = var.jwt_secret_arn
  encryption_key_secret_arn = var.encryption_key_secret_arn

  # --- DNS (optional) ---
  domain_name    = var.domain_name
  hosted_zone_id = var.hosted_zone_id

  # --- App environment ---
  env = {
    APP_URL                         = var.app_url
    SELF_SERVICE_ONBOARDING_ENABLED = "true"
    TENANT_DATA_ENCRYPTION          = "true"
    RESEND_API_KEY                  = var.resend_api_key
    EMAIL_FROM                      = var.email_from
    NEW_RELIC_APP_NAME              = var.new_relic_app_name
    NEW_RELIC_LICENSE_KEY           = var.new_relic_license_key
  }

  tags = {
    Environment = "production"
  }
}

# --- Outputs ---

output "application_url" {
  value = module.openmercato.application_url
}

output "alb_dns_name" {
  value = module.openmercato.alb_dns_name
}

output "ecr_repository_url" {
  value = module.openmercato.ecr_repository_url
}

output "cluster_name" {
  value = module.openmercato.cluster_name
}

output "web_service_name" {
  value = module.openmercato.web_service_name
}

output "worker_service_names" {
  value = module.openmercato.worker_service_names
}

output "database_endpoint" {
  value     = module.openmercato.database_endpoint
  sensitive = true
}
