import { Migration } from '@mikro-orm/migrations';

export class Migration20260814172130_finoo_affiliates extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "finoo_affiliates" add "commission_mode" text null, add "commission_rate_bps" int null, add "commission_fixed_amount" int null;`);

    this.addSql(`alter table "finoo_affiliate_transactions" add "commission_mode" text not null default 'legacy_deal_amount', add "commission_rate_bps" int null, add "commission_fixed_amount" int null, add "commission_base_amount" numeric(14,2) null;`);

    this.addSql(`alter table "finoo_deal_acceptances" add "deal_value_amount" numeric(14,2) null, add "deal_value_currency" text null;`);

    this.addSql(`
      update finoo_deal_acceptances acceptance
      set deal_value_amount = deal.value_amount,
          deal_value_currency = deal.value_currency
      from customer_deals deal
      where deal.tenant_id = acceptance.tenant_id
        and deal.organization_id = acceptance.organization_id
        and deal.id = acceptance.deal_id
        and acceptance.deal_value_amount is null
        and acceptance.deal_value_currency is null;
    `);

    this.addSql(`
      create or replace function finoo_capture_first_deal_acceptance()
      returns trigger
      language plpgsql
      as $$
      begin
        if lower(btrim(new.stage_label)) = 'accepted' then
          insert into finoo_deal_acceptances
            (id, organization_id, tenant_id, deal_id, accepted_at, deal_value_amount, deal_value_currency, created_at, updated_at)
          values
            (
              gen_random_uuid(),
              new.organization_id,
              new.tenant_id,
              new.deal_id,
              new.transitioned_at,
              (select deal.value_amount from customer_deals deal where deal.tenant_id = new.tenant_id and deal.organization_id = new.organization_id and deal.id = new.deal_id),
              (select deal.value_currency from customer_deals deal where deal.tenant_id = new.tenant_id and deal.organization_id = new.organization_id and deal.id = new.deal_id),
              now(),
              now()
            )
          on conflict (tenant_id, organization_id, deal_id) do nothing;
        end if;
        return new;
      end;
      $$;
    `);
  }

  override down(): void {}

}
