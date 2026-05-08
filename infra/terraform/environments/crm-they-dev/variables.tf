variable "aws_region" {
  type        = string
  description = "AWS region for the CRM environment. Must stay in London."
  default     = "eu-west-2"

  validation {
    condition     = var.aws_region == "eu-west-2"
    error_message = "crm.they.dev must be deployed in AWS London (eu-west-2)."
  }
}

variable "name_prefix" {
  type        = string
  description = "Prefix for all CRM resources."
  default     = "openmercato-crm-they-dev"
}

variable "domain_name" {
  type        = string
  description = "Public CRM hostname."
  default     = "crm.they.dev"
}

variable "app_url" {
  type        = string
  description = "Public CRM URL."
  default     = "https://crm.they.dev"
}

variable "hosted_zone_id" {
  type        = string
  description = "Route53 hosted zone id for they.dev."
  default     = "Z05995411RZM1GDPTHOZ6"
}

variable "vpc_id" {
  type        = string
  description = "Shared they-lb VPC id."
  default     = "vpc-20252849"
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "Subnets for the single EC2 host and RDS subnet group."
  default     = ["subnet-b41426cf", "subnet-79f9bb34", "subnet-886ebbe1"]
}

variable "alb_arn" {
  type        = string
  description = "Existing they-lb ARN."
  default     = "arn:aws:elasticloadbalancing:eu-west-2:062648047691:loadbalancer/app/they-lb/fe10e6ccedf3d536"
}

variable "alb_security_group_id" {
  type        = string
  description = "Existing they-lb security group id."
  default     = "sg-0855bb417b5a17266"
}

variable "alb_dns_name" {
  type        = string
  description = "Existing they-lb DNS name."
  default     = "they-lb-1760303051.eu-west-2.elb.amazonaws.com"
}

variable "alb_zone_id" {
  type        = string
  description = "Existing they-lb canonical hosted zone id."
  default     = "ZHURV8PSTC4K8"
}

variable "https_listener_arn" {
  type        = string
  description = "Existing they-lb HTTPS listener ARN."
  default     = "arn:aws:elasticloadbalancing:eu-west-2:062648047691:listener/app/they-lb/fe10e6ccedf3d536/15478d3e1d97aedc"
}

variable "listener_rule_priority" {
  type        = number
  description = "Dedicated they-lb listener priority for crm.they.dev."
  default     = 1002
}

variable "instance_type" {
  type        = string
  description = "Cost-conscious x86_64 EC2 instance type."
  default     = "t3a.medium"

  validation {
    condition     = contains(["t3a.medium", "t3.medium", "t3a.large", "t3.large"], var.instance_type)
    error_message = "Use at least a 4GB x86_64 instance. t3/t3a small have only 2GB RAM and are intentionally blocked."
  }
}

variable "root_volume_size_gb" {
  type        = number
  description = "Root gp3 volume size."
  default     = 30
}

variable "app_port" {
  type        = number
  description = "Host port exposed to the ALB target group."
  default     = 3001
}

variable "db_instance_class" {
  type        = string
  description = "Small RDS instance class for the single-company CRM."
  default     = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type        = number
  description = "RDS gp3 storage size in GB."
  default     = 20
}

variable "db_backup_retention_days" {
  type        = number
  description = "RDS automated backup retention."
  default     = 7
}

variable "deploy_repo_url" {
  type        = string
  description = "Git repository cloned by the CRM host deploy script."
  default     = "https://github.com/TH-EY/open-mercato.git"
}

variable "deploy_branch" {
  type        = string
  description = "Branch deployed by default to crm.they.dev."
  default     = "fork/crm-they-dev"
}

variable "admin_email" {
  type        = string
  description = "Initial THEY admin email for Open Mercato init."
  default     = "crm-admin@they.dev"
}

variable "allowed_admin_cidr_blocks" {
  type        = list(string)
  description = "Optional CIDR blocks allowed to access SSH for emergency admin. SSM is preferred."
  default     = []
}

variable "github_deploy_role_name" {
  type        = string
  description = "Existing GitHub Actions deployment role that may deploy crm.they.dev."
  default     = "github-openmercato-deploy"
}
