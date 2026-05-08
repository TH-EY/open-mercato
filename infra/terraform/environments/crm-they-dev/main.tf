provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "open-mercato"
      Environment = "crm-they-dev"
      ManagedBy   = "terraform"
      Owner       = "THEY"
    }
  }
}

module "crm" {
  source = "../../modules/single_ec2_rds_crm"

  aws_region                = var.aws_region
  name_prefix               = var.name_prefix
  domain_name               = var.domain_name
  app_url                   = var.app_url
  hosted_zone_id            = var.hosted_zone_id
  vpc_id                    = var.vpc_id
  public_subnet_ids         = var.public_subnet_ids
  alb_arn                   = var.alb_arn
  alb_security_group_id     = var.alb_security_group_id
  alb_dns_name              = var.alb_dns_name
  alb_zone_id               = var.alb_zone_id
  https_listener_arn        = var.https_listener_arn
  listener_rule_priority    = var.listener_rule_priority
  instance_type             = var.instance_type
  root_volume_size_gb       = var.root_volume_size_gb
  app_port                  = var.app_port
  db_instance_class         = var.db_instance_class
  db_allocated_storage_gb   = var.db_allocated_storage_gb
  db_backup_retention_days  = var.db_backup_retention_days
  deploy_repo_url           = var.deploy_repo_url
  deploy_branch             = var.deploy_branch
  admin_email               = var.admin_email
  allowed_admin_cidr_blocks = var.allowed_admin_cidr_blocks
}
