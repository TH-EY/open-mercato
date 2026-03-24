# -----------------------------------------------------------------------------
# Web service autoscaling
# -----------------------------------------------------------------------------

resource "aws_appautoscaling_target" "web" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.web_service.autoscaling.min_capacity
  max_capacity       = var.web_service.autoscaling.max_capacity
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${var.name}-web-cpu-scaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = var.web_service.autoscaling.cpu_target
    scale_in_cooldown  = var.web_service.autoscaling.scale_in_cooldown
    scale_out_cooldown = var.web_service.autoscaling.scale_out_cooldown

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "web_memory" {
  name               = "${var.name}-web-memory-scaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = var.web_service.autoscaling.memory_target
    scale_in_cooldown  = var.web_service.autoscaling.scale_in_cooldown
    scale_out_cooldown = var.web_service.autoscaling.scale_out_cooldown

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}

# -----------------------------------------------------------------------------
# Worker service autoscaling (split_workers mode)
# -----------------------------------------------------------------------------

resource "aws_appautoscaling_target" "worker" {
  for_each = local.split_workers ? var.worker_services : {}

  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.worker[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.autoscaling.min_capacity
  max_capacity       = each.value.autoscaling.max_capacity
}

resource "aws_appautoscaling_policy" "worker_cpu" {
  for_each = local.split_workers ? var.worker_services : {}

  name               = "${var.name}-worker-${each.key}-cpu-scaling"
  service_namespace  = aws_appautoscaling_target.worker[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.worker[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.worker[each.key].scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.autoscaling.cpu_target
    scale_in_cooldown  = each.value.autoscaling.scale_in_cooldown
    scale_out_cooldown = each.value.autoscaling.scale_out_cooldown

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "worker_memory" {
  for_each = local.split_workers ? var.worker_services : {}

  name               = "${var.name}-worker-${each.key}-memory-scaling"
  service_namespace  = aws_appautoscaling_target.worker[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.worker[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.worker[each.key].scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.autoscaling.memory_target
    scale_in_cooldown  = each.value.autoscaling.scale_in_cooldown
    scale_out_cooldown = each.value.autoscaling.scale_out_cooldown

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}
