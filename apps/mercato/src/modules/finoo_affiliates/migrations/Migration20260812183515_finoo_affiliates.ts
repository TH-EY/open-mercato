import { Migration } from '@mikro-orm/migrations';

export class Migration20260812183515_finoo_affiliates extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_affiliate_links" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "affiliate_user_id" uuid not null, "code" text not null, "label" text not null, "destination_url" text not null, "is_active" boolean not null default true, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "finoo_affiliate_links_scope_affiliate_idx" on "finoo_affiliate_links" ("tenant_id", "organization_id", "affiliate_user_id");`);
    this.addSql(`alter table "finoo_affiliate_links" add constraint "finoo_affiliate_links_code_unique" unique ("code");`);

    this.addSql(`create table "finoo_affiliate_visits" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "affiliate_link_id" uuid not null, "affiliate_user_id" uuid not null, "visitor_hash" text not null, "visited_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "finoo_affiliate_visits_scope_affiliate_time_idx" on "finoo_affiliate_visits" ("tenant_id", "organization_id", "affiliate_user_id", "visited_at");`);
    this.addSql(`create index "finoo_affiliate_visits_unique_window_idx" on "finoo_affiliate_visits" ("affiliate_link_id", "visitor_hash", "visited_at");`);

    this.addSql(`create table "finoo_deal_attributions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "deal_id" uuid not null, "affiliate_user_id" uuid not null, "affiliate_code" text not null, "company_name" text null, "landing_page" text null, "initial_referrer" text null, "commission_status_entry_id" uuid not null, "commission_status" text not null, "commission_amount" int not null default 0, "lead_at" timestamptz not null, "transaction_at" timestamptz null, "attribution_source" text not null default 'automatic', "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "finoo_deal_attributions_scope_affiliate_transaction_idx" on "finoo_deal_attributions" ("tenant_id", "organization_id", "affiliate_user_id", "transaction_at");`);
    this.addSql(`create index "finoo_deal_attributions_scope_affiliate_lead_idx" on "finoo_deal_attributions" ("tenant_id", "organization_id", "affiliate_user_id", "lead_at");`);
    this.addSql(`alter table "finoo_deal_attributions" add constraint "finoo_deal_attributions_scope_deal_unique" unique ("tenant_id", "organization_id", "deal_id");`);
  }

}
