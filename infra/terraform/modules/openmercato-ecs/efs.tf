# -----------------------------------------------------------------------------
# EFS - Meilisearch data (gated by local.create_managed_meilisearch)
# -----------------------------------------------------------------------------

resource "aws_efs_file_system" "meilisearch" {
  count = local.create_managed_meilisearch ? 1 : 0

  encrypted = true

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = merge(local.common_tags, { Name = "${var.name}-meilisearch" })
}

resource "aws_efs_mount_target" "meilisearch" {
  count = local.create_managed_meilisearch ? length(local.private_subnet_ids) : 0

  file_system_id  = aws_efs_file_system.meilisearch[0].id
  subnet_id       = local.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "meilisearch" {
  count = local.create_managed_meilisearch ? 1 : 0

  file_system_id = aws_efs_file_system.meilisearch[0].id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/meili_data"

    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "755"
    }
  }

  tags = merge(local.common_tags, { Name = "${var.name}-meilisearch" })
}

# -----------------------------------------------------------------------------
# EFS - App storage (always created)
# -----------------------------------------------------------------------------

resource "aws_efs_file_system" "app_storage" {
  encrypted = true

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = merge(local.common_tags, { Name = "${var.name}-app-storage" })
}

resource "aws_efs_mount_target" "app_storage" {
  count = length(local.private_subnet_ids)

  file_system_id  = aws_efs_file_system.app_storage.id
  subnet_id       = local.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "app_storage" {
  file_system_id = aws_efs_file_system.app_storage.id

  posix_user {
    uid = 1001
    gid = 1001
  }

  root_directory {
    path = "/app-storage"

    creation_info {
      owner_uid   = 1001
      owner_gid   = 1001
      permissions = "755"
    }
  }

  tags = merge(local.common_tags, { Name = "${var.name}-app-storage" })
}
