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
