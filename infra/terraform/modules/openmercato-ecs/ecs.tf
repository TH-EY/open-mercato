# -----------------------------------------------------------------------------
# ECS cluster
# -----------------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Web task definition
# -----------------------------------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_service.cpu
  memory                   = var.web_service.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  volume {
    name = "app-storage"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.app_storage.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.app_storage.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    merge(
      {
        name  = "app"
        image = var.image

        portMappings = [
          { containerPort = var.container_port }
        ]

        mountPoints = [
          {
            sourceVolume  = "app-storage"
            containerPath = "/app/apps/mercato/storage"
          }
        ]

        environment = [for k, v in local.web_env : { name = k, value = v }]
        secrets     = [for k, v in local.base_secrets : { name = k, valueFrom = v }]

        # No container health check - ALB health check handles this for web services.
        # Container health checks conflict with long init/migration on first boot.

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.web.name
            "awslogs-region"        = var.aws_region
            "awslogs-stream-prefix" = "web"
          }
        }
      },
      var.web_service.command != null ? { command = var.web_service.command } : {}
    )
  ])

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Web ECS service
# -----------------------------------------------------------------------------

resource "aws_ecs_service" "web" {
  name            = "${var.name}-web"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_service.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.ecs_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = local.ecs_assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "app"
    container_port   = var.container_port
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  depends_on = [aws_lb.this]

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Worker task definitions (split_workers mode)
# -----------------------------------------------------------------------------

resource "aws_ecs_task_definition" "worker" {
  for_each = local.split_workers ? var.worker_services : {}

  family                   = "${var.name}-worker-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name    = "worker"
      image   = var.image
      command = each.value.command

      environment = [for k, v in local.worker_env : { name = k, value = v }]
      secrets     = [for k, v in local.base_secrets : { name = k, valueFrom = v }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker[each.key].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Worker ECS services (split_workers mode)
# -----------------------------------------------------------------------------

resource "aws_ecs_service" "worker" {
  for_each = local.split_workers ? var.worker_services : {}

  name            = "${var.name}-worker-${each.key}"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.ecs_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = local.ecs_assign_public_ip
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Scheduler sync task definition (split_workers mode, optional)
# -----------------------------------------------------------------------------

resource "aws_ecs_task_definition" "scheduler_sync" {
  count = local.split_workers && var.scheduler_sync_task.enabled ? 1 : 0

  family                   = "${var.name}-scheduler-sync"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.scheduler_sync_task.cpu
  memory                   = var.scheduler_sync_task.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name    = "scheduler-sync"
      image   = var.image
      command = var.scheduler_sync_task.command

      environment = [for k, v in local.worker_env : { name = k, value = v }]
      secrets     = [for k, v in local.base_secrets : { name = k, valueFrom = v }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.scheduler_sync[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "scheduler-sync"
        }
      }
    }
  ])

  tags = local.common_tags
}
