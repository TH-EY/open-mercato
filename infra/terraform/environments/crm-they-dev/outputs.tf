output "application_url" {
  value = module.crm.application_url
}

output "instance_id" {
  value = module.crm.instance_id
}

output "rds_endpoint" {
  value = module.crm.rds_endpoint
}

output "target_group_arn" {
  value = module.crm.target_group_arn
}

output "ecr_repository_url" {
  value = module.crm.ecr_repository_url
}

output "runtime_secret_arns" {
  value     = module.crm.runtime_secret_arns
  sensitive = true
}
