import { Migration } from '@mikro-orm/migrations';

export class Migration20260813134051_finoo_affiliates extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_affiliates" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "invitation_id" uuid null, "customer_user_id" uuid null, "email" text not null, "email_hash" text not null, "code" text not null, "primary_link_id" uuid null, "account_holder_name" text null, "account_number" text null, "is_active" boolean not null default false, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "finoo_affiliates_scope_active_idx" on "finoo_affiliates" ("tenant_id", "organization_id", "is_active", "created_at");`);
    this.addSql(`create unique index "finoo_affiliates_scope_customer_user_unique" on "finoo_affiliates" ("tenant_id", "organization_id", "customer_user_id") where "customer_user_id" is not null and "deleted_at" is null;`);
    this.addSql(`create unique index "finoo_affiliates_scope_invitation_unique" on "finoo_affiliates" ("tenant_id", "organization_id", "invitation_id") where "invitation_id" is not null and "deleted_at" is null;`);
    this.addSql(`create unique index "finoo_affiliates_scope_email_hash_unique" on "finoo_affiliates" ("tenant_id", "organization_id", "email_hash") where "deleted_at" is null;`);
    this.addSql(`alter table "finoo_affiliates" add constraint "finoo_affiliates_code_unique" unique ("code");`);
    this.addSql(`alter table "finoo_affiliates" add constraint "finoo_affiliates_code_format_check" check ("code" ~ '^[A-Z0-9]{24}$');`);

    this.addSql(`create table "finoo_affiliate_payouts" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "affiliate_id" uuid not null, "affiliate_user_id" uuid not null, "payment_reference" text not null, "amount" bigint not null, "currency" text not null default 'PLN', "account_holder_name" text not null, "account_number" text not null, "paid_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "finoo_affiliate_payouts_scope_affiliate_time_idx" on "finoo_affiliate_payouts" ("tenant_id", "organization_id", "affiliate_id", "paid_at");`);
    this.addSql(`alter table "finoo_affiliate_payouts" add constraint "finoo_affiliate_payouts_reference_unique" unique ("payment_reference");`);

    this.addSql(`create table "finoo_affiliate_transactions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "affiliate_id" uuid not null, "affiliate_user_id" uuid not null, "deal_id" uuid not null, "deal_name" text null, "deal_company" text null, "commission_amount" int not null, "currency" text not null default 'PLN', "commission_status_entry_id" uuid not null, "commission_status" text not null, "accepted_at" timestamptz not null, "payout_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "finoo_affiliate_transactions_scope_payout_idx" on "finoo_affiliate_transactions" ("tenant_id", "organization_id", "payout_id");`);
    this.addSql(`create index "finoo_affiliate_transactions_scope_user_time_idx" on "finoo_affiliate_transactions" ("tenant_id", "organization_id", "affiliate_user_id", "accepted_at");`);
    this.addSql(`create index "finoo_affiliate_transactions_scope_status_idx" on "finoo_affiliate_transactions" ("tenant_id", "organization_id", "affiliate_id", "commission_status", "accepted_at");`);
    this.addSql(`alter table "finoo_affiliate_transactions" add constraint "finoo_affiliate_transactions_scope_deal_unique" unique ("tenant_id", "organization_id", "deal_id");`);

    this.addSql(`create table "finoo_deal_acceptances" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "deal_id" uuid not null, "accepted_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "finoo_deal_acceptances" add constraint "finoo_deal_acceptances_scope_deal_unique" unique ("tenant_id", "organization_id", "deal_id");`);

    this.addSql(`create table "finoo_payout_previews" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "payment_reference" text not null, "affiliate_id" uuid not null, "binding_hash" text not null, "selection" jsonb not null, "amount" bigint not null, "currency" text not null default 'PLN', "expires_at" timestamptz not null, "payout_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "finoo_payout_previews_scope_payout_idx" on "finoo_payout_previews" ("tenant_id", "organization_id", "payout_id");`);
    this.addSql(`create index "finoo_payout_previews_scope_expiry_idx" on "finoo_payout_previews" ("tenant_id", "organization_id", "expires_at");`);
    this.addSql(`alter table "finoo_payout_previews" add constraint "finoo_payout_previews_reference_unique" unique ("payment_reference");`);

    this.addSql(`alter table "finoo_affiliate_links" add "affiliate_id" uuid null;`);
    this.addSql(`create index "finoo_affiliate_links_scope_membership_idx" on "finoo_affiliate_links" ("tenant_id", "organization_id", "affiliate_id");`);

    this.addSql(`alter table "finoo_deal_attributions" add "affiliate_id" uuid null;`);
    this.addSql(`create index "finoo_deal_attributions_scope_membership_idx" on "finoo_deal_attributions" ("tenant_id", "organization_id", "affiliate_id");`);

    this.addSql(`alter table "finoo_affiliates" add constraint "finoo_affiliates_primary_link_id_foreign" foreign key ("primary_link_id") references "finoo_affiliate_links" ("id");`);
    this.addSql(`alter table "finoo_affiliate_links" add constraint "finoo_affiliate_links_affiliate_id_foreign" foreign key ("affiliate_id") references "finoo_affiliates" ("id");`);
    this.addSql(`alter table "finoo_deal_attributions" add constraint "finoo_deal_attributions_affiliate_id_foreign" foreign key ("affiliate_id") references "finoo_affiliates" ("id");`);
    this.addSql(`alter table "finoo_affiliate_payouts" add constraint "finoo_affiliate_payouts_affiliate_id_foreign" foreign key ("affiliate_id") references "finoo_affiliates" ("id");`);
    this.addSql(`alter table "finoo_affiliate_transactions" add constraint "finoo_affiliate_transactions_affiliate_id_foreign" foreign key ("affiliate_id") references "finoo_affiliates" ("id");`);
    this.addSql(`alter table "finoo_affiliate_transactions" add constraint "finoo_affiliate_transactions_payout_id_foreign" foreign key ("payout_id") references "finoo_affiliate_payouts" ("id");`);
    this.addSql(`alter table "finoo_payout_previews" add constraint "finoo_payout_previews_affiliate_id_foreign" foreign key ("affiliate_id") references "finoo_affiliates" ("id");`);
    this.addSql(`alter table "finoo_payout_previews" add constraint "finoo_payout_previews_payout_id_foreign" foreign key ("payout_id") references "finoo_affiliate_payouts" ("id");`);

    this.addSql(`
      create or replace function finoo_capture_first_deal_acceptance()
      returns trigger
      language plpgsql
      as $$
      begin
        if lower(btrim(new.stage_label)) = 'accepted' then
          insert into finoo_deal_acceptances
            (id, organization_id, tenant_id, deal_id, accepted_at, created_at, updated_at)
          values
            (gen_random_uuid(), new.organization_id, new.tenant_id, new.deal_id, new.transitioned_at, now(), now())
          on conflict (tenant_id, organization_id, deal_id) do nothing;
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger finoo_capture_first_deal_acceptance
      after insert or update of stage_label, transitioned_at
      on customer_deal_stage_transitions
      for each row
      execute function finoo_capture_first_deal_acceptance();
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists finoo_capture_first_deal_acceptance on customer_deal_stage_transitions;`);
    this.addSql(`drop function if exists finoo_capture_first_deal_acceptance();`);

    this.addSql(`alter table "finoo_payout_previews" drop constraint if exists "finoo_payout_previews_payout_id_foreign";`);
    this.addSql(`alter table "finoo_payout_previews" drop constraint if exists "finoo_payout_previews_affiliate_id_foreign";`);
    this.addSql(`alter table "finoo_affiliate_transactions" drop constraint if exists "finoo_affiliate_transactions_payout_id_foreign";`);
    this.addSql(`alter table "finoo_affiliate_transactions" drop constraint if exists "finoo_affiliate_transactions_affiliate_id_foreign";`);
    this.addSql(`alter table "finoo_affiliate_payouts" drop constraint if exists "finoo_affiliate_payouts_affiliate_id_foreign";`);
    this.addSql(`alter table "finoo_deal_attributions" drop constraint if exists "finoo_deal_attributions_affiliate_id_foreign";`);
    this.addSql(`alter table "finoo_affiliate_links" drop constraint if exists "finoo_affiliate_links_affiliate_id_foreign";`);
    this.addSql(`alter table "finoo_affiliates" drop constraint if exists "finoo_affiliates_primary_link_id_foreign";`);

    this.addSql(`drop index "finoo_affiliate_links_scope_membership_idx";`);
    this.addSql(`alter table "finoo_affiliate_links" drop column "affiliate_id";`);

    this.addSql(`drop index "finoo_deal_attributions_scope_membership_idx";`);
    this.addSql(`alter table "finoo_deal_attributions" drop column "affiliate_id";`);

    this.addSql(`drop table if exists "finoo_payout_previews";`);
    this.addSql(`drop table if exists "finoo_deal_acceptances";`);
    this.addSql(`drop table if exists "finoo_affiliate_transactions";`);
    this.addSql(`drop table if exists "finoo_affiliate_payouts";`);
    this.addSql(`drop table if exists "finoo_affiliates";`);
  }

}
