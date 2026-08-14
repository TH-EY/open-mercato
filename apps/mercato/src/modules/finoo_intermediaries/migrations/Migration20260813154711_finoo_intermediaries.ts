import { Migration } from '@mikro-orm/migrations';

export class Migration20260813154711_finoo_intermediaries extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_intermediary_assignments" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "deal_id" uuid not null, "intermediary_customer_user_id" uuid not null, "intermediary_role_id" uuid not null, "eligible_stage_id" uuid not null, "partner_status" text not null default 'new', "assigned_by_user_id" uuid not null, "status_updated_by_customer_user_id" uuid null, "status_updated_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "finoo_intermediary_assignments_staff_idx" on "finoo_intermediary_assignments" ("tenant_id", "organization_id", "deal_id", "deleted_at");`);
    this.addSql(`create index "finoo_intermediary_assignments_portal_idx" on "finoo_intermediary_assignments" ("tenant_id", "organization_id", "intermediary_customer_user_id", "deleted_at", "updated_at", "id");`);
    this.addSql(`create unique index "finoo_intermediary_assignments_active_deal_uq" on "finoo_intermediary_assignments" ("tenant_id", "organization_id", "deal_id") where "deleted_at" is null;`);
    this.addSql(`alter table "finoo_intermediary_assignments" add constraint "finoo_intermediary_assignments_partner_status_chk" check ("partner_status" in ('new', 'in_progress', 'done'));`);

    this.addSql(`create table "finoo_intermediary_notes" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "assignment_id" uuid not null, "author_customer_user_id" uuid not null, "body" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "finoo_intermediary_notes_staff_idx" on "finoo_intermediary_notes" ("tenant_id", "organization_id", "assignment_id", "deleted_at", "created_at", "id");`);
    this.addSql(`create index "finoo_intermediary_notes_portal_idx" on "finoo_intermediary_notes" ("tenant_id", "organization_id", "assignment_id", "author_customer_user_id", "deleted_at", "created_at", "id");`);

    this.addSql(`alter table "finoo_intermediary_notes" add constraint "finoo_intermediary_notes_assignment_id_foreign" foreign key ("assignment_id") references "finoo_intermediary_assignments" ("id");`);
  }

}
