output "application_url" {
  value = var.app_url
}

output "instance_id" {
  value = aws_instance.app.id
}

output "rds_endpoint" {
  value = aws_db_instance.crm.address
}

output "target_group_arn" {
  value = aws_lb_target_group.app.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "runtime_secret_arns" {
  value = {
    database_url           = aws_secretsmanager_secret.database_url.arn
    jwt_secret             = aws_secretsmanager_secret.jwt_secret.arn
    tenant_data_encryption = aws_secretsmanager_secret.encryption_key.arn
    meilisearch_master_key = aws_secretsmanager_secret.meilisearch_master_key.arn
    initial_admin_password = aws_secretsmanager_secret.admin_password.arn
  }
  sensitive = true
}
