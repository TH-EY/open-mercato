import { Migration } from '@mikro-orm/migrations';

export class Migration20260818152929_finoo_intermediaries extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_intermediary_assignment_batches" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "binding_hash" text not null, "result" jsonb not null, "completed_at" timestamptz not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "finoo_intermediary_assignment_batches_scope_idx" on "finoo_intermediary_assignment_batches" ("tenant_id", "organization_id", "created_at");`);
  }

}
