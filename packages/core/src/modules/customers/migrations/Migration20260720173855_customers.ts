import { Migration } from '@mikro-orm/migrations';

export class Migration20260720173855_customers extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "customer_interactions" add "completion_event_emitted_at" timestamptz null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "customer_interactions" drop column "completion_event_emitted_at";`);
  }

}
