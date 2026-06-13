import { Migration } from '@mikro-orm/migrations';

export class Migration20260613010301_projects extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "project_task_templates" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "status" text not null, "description" text null, "owner_user_id" uuid null, "due_in_days" int null, "is_active" boolean not null default true, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "project_task_templates_tenant_org_idx" on "project_task_templates" ("tenant_id", "organization_id");`);

    this.addSql(`create table "project_templates" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "description" text null, "is_active" boolean not null default true, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "project_templates_tenant_org_idx" on "project_templates" ("tenant_id", "organization_id");`);

    this.addSql(`create table "project_template_tasks" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "project_template_id" uuid not null, "task_template_id" uuid null, "name" text null, "status" text null, "description" text null, "owner_user_id" uuid null, "due_in_days" int null, "position" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "project_template_tasks_template_position_idx" on "project_template_tasks" ("project_template_id", "position");`);
    this.addSql(`create index "project_template_tasks_tenant_org_idx" on "project_template_tasks" ("tenant_id", "organization_id");`);

    this.addSql(`alter table "project_template_tasks" add constraint "project_template_tasks_project_template_id_foreign" foreign key ("project_template_id") references "project_templates" ("id");`);
    this.addSql(`alter table "project_template_tasks" add constraint "project_template_tasks_task_template_id_foreign" foreign key ("task_template_id") references "project_task_templates" ("id") on delete set null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "project_template_tasks" drop constraint if exists "project_template_tasks_task_template_id_foreign";`);
    this.addSql(`alter table "project_template_tasks" drop constraint if exists "project_template_tasks_project_template_id_foreign";`);
    this.addSql(`drop table if exists "project_template_tasks" cascade;`);
    this.addSql(`drop table if exists "project_templates" cascade;`);
    this.addSql(`drop table if exists "project_task_templates" cascade;`);
  }

}
