# -----------------------------------------------------------------------------
# Meilisearch - Cloud Map service discovery + ECS service
# All resources gated by local.create_managed_meilisearch
# -----------------------------------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "internal" {
  count = local.create_managed_meilisearch ? 1 : 0

  name = local.service_discovery_namespace
  vpc  = local.vpc_id

  tags = merge(local.common_tags, { Name = local.service_discovery_namespace })
}

resource "aws_service_discovery_service" "meilisearch" {
  count = local.create_managed_meilisearch ? 1 : 0

  name         = "meilisearch"
  namespace_id = aws_service_discovery_private_dns_namespace.internal[0].id

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal[0].id

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  lifecycle {
    ignore_changes = [health_check_custom_config]
  }

  tags = merge(local.common_tags, { Name = "${var.name}-meilisearch" })
}

# -----------------------------------------------------------------------------
# Meilisearch master key
# -----------------------------------------------------------------------------

resource "random_password" "meilisearch_master_key" {
  count   = local.create_managed_meilisearch ? 1 : 0
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "meilisearch_api_key" {
  count = local.create_managed_meilisearch ? 1 : 0

  name = "${var.name}/meilisearch-api-key"

  tags = merge(local.common_tags, { Name = "${var.name}/meilisearch-api-key" })
}

resource "aws_secretsmanager_secret_version" "meilisearch_api_key" {
  count = local.create_managed_meilisearch ? 1 : 0

  secret_id     = aws_secretsmanager_secret.meilisearch_api_key[0].id
  secret_string = random_password.meilisearch_master_key[0].result
}

# -----------------------------------------------------------------------------
# ECS task definition
# -----------------------------------------------------------------------------

resource "aws_ecs_task_definition" "meilisearch" {
  count = local.create_managed_meilisearch ? 1 : 0

  family                   = "${var.name}-meilisearch"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.meilisearch_service.cpu
  memory                   = var.meilisearch_service.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "meili-data"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.meilisearch[0].id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.meilisearch[0].id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name  = "meilisearch"
      image = var.meilisearch_image

      portMappings = [
        {
          containerPort = 7700
          protocol      = "tcp"
        }
      ]

      mountPoints = [
        {
          sourceVolume  = "meili-data"
          containerPath = "/meili_data"
          readOnly      = false
        }
      ]

      environment = [
        { name = "MEILI_ENV", value = "production" },
        { name = "MEILI_NO_ANALYTICS", value = "true" },
        { name = "MEILI_HTTP_ADDR", value = "0.0.0.0:7700" }
      ]

      secrets = [
        {
          name      = "MEILI_MASTER_KEY"
          valueFrom = aws_secretsmanager_secret.meilisearch_api_key[0].arn
        }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:7700/health || exit 1"]
        interval    = 10
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.meilisearch[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "meilisearch"
        }
      }
    }
  ])

  tags = merge(local.common_tags, { Name = "${var.name}-meilisearch" })
}

# -----------------------------------------------------------------------------
# ECS service
# -----------------------------------------------------------------------------

resource "aws_ecs_service" "meilisearch" {
  count = local.create_managed_meilisearch ? 1 : 0

  name            = "${var.name}-meilisearch"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.meilisearch[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.ecs_subnet_ids
    security_groups  = [aws_security_group.meilisearch[0].id]
    assign_public_ip = local.ecs_assign_public_ip
  }

  service_registries {
    registry_arn = aws_service_discovery_service.meilisearch[0].arn
  }

  tags = merge(local.common_tags, { Name = "${var.name}-meilisearch" })
}
