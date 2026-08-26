import { Migration } from '@mikro-orm/migrations'

export class Migration20260826204500_query_index extends Migration {
  override up(): void | Promise<void> {
    this.addSql(`drop index if exists "entity_indexes_customer_person_profile_doc_idx";`)
    this.addSql(`create index "entity_indexes_customer_person_profile_doc_idx" on "entity_indexes" ("entity_id", "organization_id", "tenant_id") where deleted_at is null and entity_type = 'customers:customer_person_profile' and organization_id is not null and tenant_id is not null;`)

    this.addSql(`drop index if exists "entity_indexes_customer_person_profile_tenant_doc_idx";`)
    this.addSql(`create index "entity_indexes_customer_person_profile_tenant_doc_idx" on "entity_indexes" ("tenant_id", "entity_id") where deleted_at is null and entity_type = 'customers:customer_person_profile' and organization_id is null and tenant_id is not null;`)
  }
}
