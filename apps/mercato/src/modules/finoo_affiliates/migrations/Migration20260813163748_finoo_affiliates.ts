import { Migration } from '@mikro-orm/migrations';

export class Migration20260813163748_finoo_affiliates extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "finoo_affiliate_payouts" add "created_event_published_at" timestamptz null;`);

    this.addSql(`alter table "finoo_affiliate_transactions" add "created_event_published_at" timestamptz null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "finoo_affiliate_payouts" drop column "created_event_published_at";`);

    this.addSql(`alter table "finoo_affiliate_transactions" drop column "created_event_published_at";`);
  }

}
