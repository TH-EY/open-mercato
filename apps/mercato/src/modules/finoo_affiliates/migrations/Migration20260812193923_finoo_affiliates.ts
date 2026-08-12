import { Migration } from '@mikro-orm/migrations';

export class Migration20260812193923_finoo_affiliates extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_deal_completions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "deal_id" uuid not null, "completed_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "finoo_deal_completions" add constraint "finoo_deal_completions_scope_deal_unique" unique ("tenant_id", "organization_id", "deal_id");`);

    this.addSql(`alter table "finoo_deal_attributions" add "deletion_reason" text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "finoo_deal_attributions" drop column "deletion_reason";`);
  }

}
