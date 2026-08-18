import { Migration } from '@mikro-orm/migrations';

export class Migration20260818162145_finoo_affiliates extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "finoo_payout_previews" add "batch_id" uuid null, add "batch_binding_hash" text null;`);
    this.addSql(`create index "finoo_payout_previews_scope_batch_idx" on "finoo_payout_previews" ("tenant_id", "organization_id", "batch_id");`);
    this.addSql(`alter table "finoo_payout_previews" add constraint "finoo_payout_previews_batch_affiliate_unique" unique ("batch_id", "affiliate_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "finoo_payout_previews_scope_batch_idx";`);
    this.addSql(`alter table "finoo_payout_previews" drop constraint if exists "finoo_payout_previews_batch_affiliate_unique";`);
    this.addSql(`alter table "finoo_payout_previews" drop column "batch_id", drop column "batch_binding_hash";`);
  }

}
