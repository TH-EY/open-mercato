import { Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'

@Entity({ tableName: 'projects' })
@Index({ name: 'projects_tenant_org_idx', properties: ['tenantId', 'organizationId'] })
@Index({ name: 'projects_order_idx', properties: ['orderId'] })
export class Project {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ name: 'order_id', type: 'uuid', nullable: true })
  orderId?: string | null

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'project_tasks' })
@Index({ name: 'project_tasks_tenant_org_idx', properties: ['tenantId', 'organizationId'] })
@Index({ name: 'project_tasks_project_status_position_idx', properties: ['project', 'status', 'position'] })
export class ProjectTask {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => Project, { fieldName: 'project_id' })
  project!: Project

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text' })
  status!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'deadline_at', type: Date, nullable: true })
  deadlineAt?: Date | null

  @Property({ type: 'int', default: 0 })
  position: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'project_task_templates' })
@Index({ name: 'project_task_templates_tenant_org_idx', properties: ['tenantId', 'organizationId'] })
export class ProjectTaskTemplate {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text' })
  status!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'due_in_days', type: 'int', nullable: true })
  dueInDays?: number | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'project_templates' })
@Index({ name: 'project_templates_tenant_org_idx', properties: ['tenantId', 'organizationId'] })
export class ProjectTemplate {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'project_template_tasks' })
@Index({ name: 'project_template_tasks_tenant_org_idx', properties: ['tenantId', 'organizationId'] })
@Index({ name: 'project_template_tasks_template_position_idx', properties: ['projectTemplate', 'position'] })
export class ProjectTemplateTask {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => ProjectTemplate, { fieldName: 'project_template_id' })
  projectTemplate!: ProjectTemplate

  @ManyToOne(() => ProjectTaskTemplate, { fieldName: 'task_template_id', nullable: true })
  taskTemplate?: ProjectTaskTemplate | null

  @Property({ type: 'text', nullable: true })
  name?: string | null

  @Property({ type: 'text', nullable: true })
  status?: string | null

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'due_in_days', type: 'int', nullable: true })
  dueInDays?: number | null

  @Property({ type: 'int', default: 0 })
  position: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
