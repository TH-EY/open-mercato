import { Migration } from '@mikro-orm/migrations';

export class Migration20260817165322_finoo_intermediaries extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_intermediaries" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "first_name" text not null, "last_name" text not null, "email" text not null, "email_hash" text not null, "lifecycle_state" text not null default 'delivery_failed', "invitation_id" uuid null, "customer_user_id" uuid null, "invitation_expires_at" timestamptz null, "last_email_kind" text null, "last_email_status" text null, "last_email_attempt_at" timestamptz null, "last_email_delivered_at" timestamptz null, "last_email_error_code" text null, "activated_at" timestamptz null, "deactivated_at" timestamptz null, "created_by_user_id" uuid null, "updated_by_user_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "finoo_intermediaries_list_idx" on "finoo_intermediaries" ("tenant_id", "organization_id", "lifecycle_state", "deleted_at", "updated_at", "id");`);
    this.addSql(`create unique index "finoo_intermediaries_scope_customer_user_uq" on "finoo_intermediaries" ("tenant_id", "organization_id", "customer_user_id") where "customer_user_id" is not null and "deleted_at" is null;`);
    this.addSql(`create unique index "finoo_intermediaries_scope_invitation_uq" on "finoo_intermediaries" ("tenant_id", "organization_id", "invitation_id") where "invitation_id" is not null and "deleted_at" is null;`);
    this.addSql(`create unique index "finoo_intermediaries_scope_email_hash_uq" on "finoo_intermediaries" ("tenant_id", "organization_id", "email_hash") where "deleted_at" is null;`);

    this.addSql(`alter table "finoo_intermediaries" add constraint "finoo_intermediaries_email_status_chk" check ("last_email_status" is null or "last_email_status" in ('pending', 'delivered', 'failed'));`);
    this.addSql(`alter table "finoo_intermediaries" add constraint "finoo_intermediaries_email_kind_chk" check ("last_email_kind" is null or "last_email_kind" in ('invitation', 'access_notice'));`);
    this.addSql(`alter table "finoo_intermediaries" add constraint "finoo_intermediaries_lifecycle_state_chk" check ("lifecycle_state" in ('delivery_failed', 'invited', 'active', 'inactive'));`);
  }

}
