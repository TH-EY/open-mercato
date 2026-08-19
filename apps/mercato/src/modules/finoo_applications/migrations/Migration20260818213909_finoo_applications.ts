import { Migration } from '@mikro-orm/migrations';

export class Migration20260818213909_finoo_applications extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "finoo_application_identity_bindings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "projection_id" uuid null, "identity_kind" text not null, "identity_hash" text not null, "reserved_entity_id" uuid not null, "customer_entity_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "finoo_application_identity_bindings" add constraint "finoo_application_identity_scope_key_unique" unique ("tenant_id", "organization_id", "identity_kind", "identity_hash");`);

    this.addSql(`create table "finoo_application_intakes" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "message_id" text not null, "body_digest" text not null, "external_lead_id" text not null, "source_timestamp" timestamptz not null, "payload_json" jsonb null, "state" text not null default 'pending', "dispatch_state" text not null default 'pending', "dispatch_lease_expires_at" timestamptz null, "attempt_count" int not null default 0, "last_error_code" text null, "next_attempt_at" timestamptz null, "lease_expires_at" timestamptz null, "processed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "finoo_application_intakes_delivery_idx" on "finoo_application_intakes" ("state", "next_attempt_at", "lease_expires_at");`);
    this.addSql(`alter table "finoo_application_intakes" add constraint "finoo_application_intakes_scope_message_unique" unique ("tenant_id", "organization_id", "message_id");`);

    this.addSql(`create table "finoo_application_projections" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "external_lead_id" text not null, "state" text not null default 'draft', "company_entity_id" uuid null, "applicant_entity_id" uuid null, "deal_id" uuid null, "last_intake_id" uuid null, "last_source_timestamp" timestamptz null, "warnings_json" jsonb not null default '[]', "submission_history_json" jsonb not null default '[]', "last_error_code" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "finoo_application_projections" add constraint "finoo_application_projections_scope_lead_unique" unique ("tenant_id", "organization_id", "external_lead_id");`);

    this.addSql(`create table "finoo_application_consent_evidence" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "intake_id" uuid not null, "projection_id" uuid not null, "consent_key" text not null, "registry_version" text not null, "registry_code" text not null, "accepted" boolean not null, "accepted_at" timestamptz not null, "transport_source_ip_digest" text null, "evidence_digest" text not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "finoo_application_consent_evidence" add constraint "finoo_application_consent_evidence_intake_key_unique" unique ("tenant_id", "organization_id", "intake_id", "consent_key");`);
  }

}
