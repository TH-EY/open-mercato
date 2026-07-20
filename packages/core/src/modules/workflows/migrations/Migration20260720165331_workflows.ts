import { Migration } from '@mikro-orm/migrations';

export class Migration20260720165331_workflows extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "step_instances" add "wait_signal_name" varchar(255) null, add "wait_correlation_key" varchar(255) null, add "wait_payload_path" varchar(500) null;`);
    this.addSql(`create index "step_instances_correlated_wait_idx" on "step_instances" ("tenant_id", "organization_id", "status", "wait_signal_name", "wait_correlation_key");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "step_instances_correlated_wait_idx";`);
    this.addSql(`alter table "step_instances" drop column "wait_signal_name", drop column "wait_correlation_key", drop column "wait_payload_path";`);
  }

}
