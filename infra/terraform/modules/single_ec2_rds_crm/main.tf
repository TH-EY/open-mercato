
data "aws_iam_role" "github_deploy" {
  name = var.github_deploy_role_name
}

data "aws_ami" "ubuntu_amd64" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "random_password" "jwt_secret" {
  length  = 48
  special = false
}

resource "random_password" "encryption_key" {
  length  = 48
  special = false
}

resource "random_password" "meilisearch_master_key" {
  length  = 32
  special = false
}

resource "random_password" "admin_password" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name                    = "${var.name_prefix}/jwt-secret"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_password.jwt_secret.result
}

resource "aws_secretsmanager_secret" "encryption_key" {
  name                    = "${var.name_prefix}/tenant-data-encryption-key"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "encryption_key" {
  secret_id     = aws_secretsmanager_secret.encryption_key.id
  secret_string = random_password.encryption_key.result
}

resource "aws_secretsmanager_secret" "meilisearch_master_key" {
  name                    = "${var.name_prefix}/meilisearch-master-key"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "meilisearch_master_key" {
  secret_id     = aws_secretsmanager_secret.meilisearch_master_key.id
  secret_string = random_password.meilisearch_master_key.result
}

resource "aws_secretsmanager_secret" "admin_password" {
  name                    = "${var.name_prefix}/initial-admin-password"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "admin_password" {
  secret_id     = aws_secretsmanager_secret.admin_password.id
  secret_string = random_password.admin_password.result
}

resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app-sg"
  description = "crm.they.dev single host app security group"
  vpc_id      = var.vpc_id

  ingress {
    description     = "they-lb to Open Mercato app"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
  }

  dynamic "ingress" {
    for_each = var.allowed_admin_cidr_blocks
    content {
      description = "Emergency SSH admin access"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    description = "Outbound internet and AWS service access"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db-sg"
  description = "crm.they.dev RDS security group"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Open Mercato host to PostgreSQL"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    description = "Allow RDS responses"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_subnet_group" "crm" {
  name       = "${var.name_prefix}-db-subnets"
  subnet_ids = var.public_subnet_ids
}

resource "aws_db_parameter_group" "crm" {
  name   = "${var.name_prefix}-postgres17"
  family = "postgres17"
}

resource "aws_db_instance" "crm" {
  identifier                = "${var.name_prefix}-postgres"
  engine                    = "postgres"
  engine_version            = "17.9"
  instance_class            = var.db_instance_class
  allocated_storage         = var.db_allocated_storage_gb
  storage_type              = "gp3"
  storage_encrypted         = true
  db_name                   = "openmercato"
  username                  = "openmercato"
  password                  = random_password.db_password.result
  publicly_accessible       = false
  deletion_protection       = true
  backup_retention_period   = var.db_backup_retention_days
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  db_subnet_group_name      = aws_db_subnet_group.crm.name
  parameter_group_name      = aws_db_parameter_group.crm.name
  vpc_security_group_ids    = [aws_security_group.db.id]

  lifecycle {
    ignore_changes = [final_snapshot_identifier]
  }
}

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name_prefix}/database-url"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgres://openmercato:${random_password.db_password.result}@${aws_db_instance.crm.address}:${aws_db_instance.crm.port}/openmercato?sslmode=require"
}

resource "aws_ecr_repository" "app" {
  name                 = "${var.name_prefix}-app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the latest 10 CRM images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_iam_role" "instance" {
  name = "${var.name_prefix}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "runtime" {
  name = "${var.name_prefix}-runtime"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          aws_secretsmanager_secret.database_url.arn,
          aws_secretsmanager_secret.jwt_secret.arn,
          aws_secretsmanager_secret.encryption_key.arn,
          aws_secretsmanager_secret.meilisearch_master_key.arn,
          aws_secretsmanager_secret.admin_password.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter"
        ]
        Resource = [
          aws_ssm_parameter.admin_email.arn,
          aws_ssm_parameter.deploy_repo_url.arn,
          aws_ssm_parameter.deploy_branch.arn,
          aws_ssm_parameter.app_image.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeImages"
        ]
        Resource = aws_ecr_repository.app.arn
      }
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name_prefix}-ec2-profile"
  role = aws_iam_role.instance.name
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu_amd64.id
  instance_type               = var.instance_type
  subnet_id                   = var.public_subnet_ids[0]
  vpc_security_group_ids      = [aws_security_group.app.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh", {
    aws_region  = var.aws_region
    name_prefix = var.name_prefix
  })

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name = var.name_prefix
  }
}

resource "aws_lb_target_group" "app" {
  name        = "om-crm-they-tg"
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    enabled             = true
    path                = "/login"
    matcher             = "200-399"
    interval            = 15
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = var.app_port
}

resource "aws_lb_listener_rule" "app" {
  listener_arn = var.https_listener_arn
  priority     = var.listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  condition {
    host_header {
      values = [var.domain_name]
    }
  }
}

resource "aws_route53_record" "app" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_ssm_parameter" "deploy_repo_url" {
  name  = "/${var.name_prefix}/deploy/repo-url"
  type  = "String"
  value = var.deploy_repo_url
}

resource "aws_ssm_parameter" "deploy_branch" {
  name  = "/${var.name_prefix}/deploy/branch"
  type  = "String"
  value = var.deploy_branch
}

resource "aws_ssm_parameter" "app_image" {
  name  = "/${var.name_prefix}/deploy/default-app-image"
  type  = "String"
  value = "${aws_ecr_repository.app.repository_url}:latest"
}

resource "aws_ssm_parameter" "admin_email" {
  name  = "/${var.name_prefix}/runtime/admin-email"
  type  = "String"
  value = var.admin_email
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "${var.name_prefix}-github-deploy"
  role = data.aws_iam_role.github_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart"
        ]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:SendCommand"
        ]
        Resource = [
          aws_instance.app.arn,
          "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetCommandInvocation",
          "ssm:ListCommandInvocations"
        ]
        Resource = "*"
      }
    ]
  })
}
