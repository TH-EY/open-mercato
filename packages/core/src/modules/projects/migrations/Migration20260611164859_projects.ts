import { Migration } from '@mikro-orm/migrations';

export class Migration20260611164859_projects extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "projects" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "order_id" uuid null, "owner_user_id" uuid null, "is_active" boolean not null default true, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "projects_order_idx" on "projects" ("order_id");`);
    this.addSql(`create index "projects_tenant_org_idx" on "projects" ("tenant_id", "organization_id");`);

    this.addSql(`create table "project_tasks" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "project_id" uuid not null, "name" text not null, "status" text not null, "description" text null, "owner_user_id" uuid null, "deadline_at" timestamptz null, "position" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "project_tasks_project_status_position_idx" on "project_tasks" ("project_id", "status", "position");`);
    this.addSql(`create index "project_tasks_tenant_org_idx" on "project_tasks" ("tenant_id", "organization_id");`);

    this.addSql(`alter table "project_tasks" add constraint "project_tasks_project_id_foreign" foreign key ("project_id") references "projects" ("id");`);
  }

}
