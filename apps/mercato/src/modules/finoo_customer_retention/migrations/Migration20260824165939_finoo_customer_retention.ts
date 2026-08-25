import { Migration } from '@mikro-orm/migrations';

export class Migration20260824165939_finoo_customer_retention extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_customer_retention_settings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "inactivity_window_days" int null, "preview_token_hash" varchar(64) null, "preview_window_days" int null, "preview_total_eligible" int null, "preview_newly_expired" int null, "preview_already_expired" int null, "preview_expires_at" timestamptz null, "reconciliation_generation" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "finoo_customer_retention_settings" add constraint "finoo_customer_retention_settings_scope_unique" unique ("tenant_id", "organization_id");`);
    this.addSql(`alter table "finoo_customer_retention_settings" add constraint "finoo_customer_retention_settings_window_days_check" check ("inactivity_window_days" is null or "inactivity_window_days" between 1 and 3650);`);

    this.addSql(`create table "finoo_customer_retention_states" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "customer_entity_id" uuid not null, "retention_status" text not null default 'active', "eligibility_anchor_at" timestamptz not null, "last_qualifying_activity_at" timestamptz null, "retention_expires_at" timestamptz null, "expired_at" timestamptz null, "last_evaluated_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "finoo_customer_retention_states_scope_customer_keyset_idx" on "finoo_customer_retention_states" ("tenant_id", "organization_id", "customer_entity_id", "id");`);
    this.addSql(`create index "finoo_customer_retention_states_scope_expiry_idx" on "finoo_customer_retention_states" ("tenant_id", "organization_id", "retention_status", "retention_expires_at");`);
    this.addSql(`create unique index "finoo_customer_retention_states_scope_customer_unique" on "finoo_customer_retention_states" ("tenant_id", "organization_id", "customer_entity_id") where "deleted_at" is null;`);
    this.addSql(`alter table "finoo_customer_retention_states" add constraint "finoo_customer_retention_states_status_check" check ("retention_status" in ('active', 'expired', 'excluded'));`);
  }

}
