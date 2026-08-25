import { Migration } from '@mikro-orm/migrations'

export class Migration20260825193000_finoo_customer_retention_identity_erasure extends Migration {
  override up(): void {
    this.addSql('alter table "finoo_customer_retention_states" add column "identity_erased_at" timestamptz null;')
    this.addSql('create index "finoo_customer_retention_states_scope_pending_erasure_idx" on "finoo_customer_retention_states" ("tenant_id", "organization_id", "retention_status", "retention_expires_at", "customer_entity_id") where "deleted_at" is null and "identity_erased_at" is null;')
  }
}
