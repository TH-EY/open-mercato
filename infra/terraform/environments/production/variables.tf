# Required
variable "image" {
  description = "Full container image reference (e.g., 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest)."
  type        = string
}

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

# Sizing
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

# Scaling
variable "web_desired_count" {
  type    = number
  default = 1
}

variable "web_min_capacity" {
  type    = number
  default = 1
}

variable "web_max_capacity" {
  type    = number
  default = 6
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "worker_max_capacity" {
  type    = number
  default = 4
}

# DNS (optional)
variable "domain_name" {
  type    = string
  default = null
}

variable "hosted_zone_id" {
  type    = string
  default = null
}

variable "app_url" {
  description = "Public-facing application URL."
  type        = string
  default     = ""
}

# Email (optional)
variable "resend_api_key" {
  type    = string
  default = ""
}

variable "email_from" {
  type    = string
  default = ""
}

# Monitoring (optional)
variable "new_relic_app_name" {
  type    = string
  default = ""
}

variable "new_relic_license_key" {
  type    = string
  default = ""
}
