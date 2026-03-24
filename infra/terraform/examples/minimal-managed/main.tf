provider "aws" {
  region = "eu-west-2"
}

module "openmercato" {
  source = "../../modules/openmercato-ecs"

  name       = "om-demo"
  aws_region = "eu-west-2"
  image      = "062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest"

  # All managed (defaults)
  networking_mode  = "managed"
  database_mode    = "managed"
  redis_mode       = "managed"
  meilisearch_mode = "managed"
  dns_mode         = "none"
  runtime_mode     = "split_workers"

  # Secrets (must be pre-created in Secrets Manager)
  jwt_secret_arn            = "arn:aws:secretsmanager:eu-west-2:062648047691:secret:om-demo/jwt-secret-XXXXXX"
  encryption_key_secret_arn = "arn:aws:secretsmanager:eu-west-2:062648047691:secret:om-demo/encryption-key-XXXXXX"

  # Small sizing for demo
  db_instance_class    = "db.t4g.micro"
  db_allocated_storage = 20

  web_service = {
    cpu           = 512
    memory        = 2048
    desired_count = 1
    autoscaling = {
      min_capacity = 1
      max_capacity = 2
    }
  }

  worker_services = {
    worker = {
      cpu           = 256
      memory        = 512
      desired_count = 1
      command       = ["sh", "-c", "yarn mercato queue worker --all"]
    }
  }

  env = {
    APP_URL                         = "http://replace-with-alb-dns"
    SELF_SERVICE_ONBOARDING_ENABLED = "true"
    DEMO_MODE                       = "true"
  }
}

output "application_url" {
  value = module.openmercato.application_url
}

output "alb_dns_name" {
  value = module.openmercato.alb_dns_name
}

output "ecr_repository_url" {
  value = module.openmercato.ecr_repository_url
}
