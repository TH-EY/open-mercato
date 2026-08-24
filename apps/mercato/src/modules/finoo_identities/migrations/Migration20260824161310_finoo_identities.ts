import { Migration } from '@mikro-orm/migrations';

export class Migration20260824161310_finoo_identities extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_identity_audit_entries" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "actor_user_id" uuid null, "actor_kind" text not null, "person_id" uuid null, "subject_digest" text not null, "operation" text not null, "outcome" text not null, "changed_fields" text[] null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "finoo_identity_audit_actor_idx" on "finoo_identity_audit_entries" ("tenant_id", "actor_user_id", "created_at");`);
    this.addSql(`create index "finoo_identity_audit_person_idx" on "finoo_identity_audit_entries" ("tenant_id", "organization_id", "person_id", "created_at");`);
    this.addSql(`alter table "finoo_identity_audit_entries" add constraint "finoo_identity_audit_outcome_chk" check ("outcome" in ('allowed', 'denied'));`);
    this.addSql(`alter table "finoo_identity_audit_entries" add constraint "finoo_identity_audit_actor_kind_chk" check ("actor_kind" in ('user', 'system'));`);

    this.addSql(`create table "finoo_identity_import_conflicts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "person_id" uuid not null, "source_module" text not null, "source_record_id" uuid not null, "candidate_digest" text not null, "candidate_pesel" text null, "candidate_document_type" text null, "candidate_issuing_country_code" text null, "candidate_document_number" text null, "candidate_issued_on" text null, "candidate_expires_on" text null, "changed_fields" text[] not null, "state" text not null default 'open', "resolved_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "finoo_identity_import_conflicts_person_idx" on "finoo_identity_import_conflicts" ("tenant_id", "organization_id", "person_id", "state", "created_at");`);
    this.addSql(`create unique index "finoo_identity_import_conflicts_open_source_uq" on "finoo_identity_import_conflicts" ("tenant_id", "organization_id", "source_module", "source_record_id", "candidate_digest") where "state" = 'open';`);
    this.addSql(`alter table "finoo_identity_import_conflicts" add constraint "finoo_identity_import_conflicts_state_chk" check ("state" in ('open', 'resolved', 'dismissed'));`);

    this.addSql(`create table "finoo_person_identities" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "person_id" uuid not null, "pesel" text null, "document_type" text null, "issuing_country_code" text null, "document_number" text null, "issued_on" text null, "expires_on" text null, "is_complete" boolean not null default false, "field_statuses" jsonb not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "finoo_person_identities_completeness_idx" on "finoo_person_identities" ("tenant_id", "organization_id", "is_complete", "person_id");`);
    this.addSql(`create unique index "finoo_person_identities_active_person_uq" on "finoo_person_identities" ("tenant_id", "organization_id", "person_id") where "deleted_at" is null;`);
  }

}
