import { Migration } from '@mikro-orm/migrations'

export class Migration20260812203500_finoo_affiliates extends Migration {
  override up(): void {
    this.addSql(`
      create or replace function finoo_capture_first_deal_completion()
      returns trigger
      language plpgsql
      as $$
      begin
        if lower(btrim(new.stage_label)) = 'completed' then
          insert into finoo_deal_completions
            (id, organization_id, tenant_id, deal_id, completed_at, created_at, updated_at)
          values
            (gen_random_uuid(), new.organization_id, new.tenant_id, new.deal_id, new.transitioned_at, now(), now())
          on conflict (tenant_id, organization_id, deal_id) do nothing;
        end if;
        return new;
      end;
      $$;
    `)
    this.addSql(`
      create trigger finoo_capture_first_deal_completion
      after insert or update of stage_label, transitioned_at
      on customer_deal_stage_transitions
      for each row
      execute function finoo_capture_first_deal_completion();
    `)
  }

  override down(): void {
    this.addSql('drop trigger if exists finoo_capture_first_deal_completion on customer_deal_stage_transitions;')
    this.addSql('drop function if exists finoo_capture_first_deal_completion();')
  }
}
