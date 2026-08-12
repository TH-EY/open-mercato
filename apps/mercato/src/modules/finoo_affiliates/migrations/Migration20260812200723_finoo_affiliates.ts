import { Migration } from '@mikro-orm/migrations';

export class Migration20260812200723_finoo_affiliates extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "finoo_affiliate_visits" alter column "visitor_hash" drop not null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "finoo_affiliate_visits" alter column "visitor_hash" set not null;`);
  }

}
