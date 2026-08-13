# Pre-Implementation Analysis: System Outbound Email Providers Through Communications Hub

## Executive Summary

The specification is ready for implementation on the private FINOO baseline after the approved core-modification decision. The design preserves the existing `sendEmail()` entrypoint, keeps provider SDKs in dedicated packages, and adds SES through Communications Hub without a new database schema. Production configuration remains gated on focused tests, a clean immutable build, current AWS/IAM/SES read-back, primary and security review, and rollback-ready deployment evidence.

## Backward Compatibility

### Violations Found

No breaking violation was found. The audited changes are additive or preserve the existing surface.

| # | Surface | Disposition | Severity | Required Control |
| --- | --- | --- | --- | --- |
| 1 | Auto-discovery conventions | Adds provider `index.ts`, `di.ts`, `acl.ts`, and `setup.ts` files without changing discovery rules | None | Run generator and inspect generated registries |
| 2 | Type definitions | Adds optional `tenantId` and `organizationId` to `SendEmailOptions` | None | Keep all existing fields and meanings |
| 3 | Function signatures | Keeps `sendEmail(options)` and adds only optional payload scope | None | Run shared compatibility tests |
| 4 | Import paths | Keeps `@open-mercato/shared/lib/email` entrypoints | None | Verify existing call sites compile |
| 5 | Event IDs | No event ID change | None | No action |
| 6 | Widget spot IDs | No widget change | None | No action |
| 7 | API routes | Existing routes remain; only their internal transport changes | None | Exercise invite, reset, signup, notifications, messages, checkout, and sales delivery paths |
| 8 | Database schema | Reuses existing integration/channel entities; no schema migration | None | Seed through provider-owned setup only |
| 9 | DI service names | Adds provider registration and a system-email transport without renaming an existing service | None | Verify disabled-provider and enabled-provider startup |
| 10 | ACL feature IDs | Adds provider package feature IDs only | None | Keep IDs stable once released and mirror grants in `setup.ts` |
| 11 | Notification type IDs | No notification type change | None | No action |
| 12 | AI agent/tool/pack IDs | No AI contract change | None | No action |
| 13 | CLI commands | No existing command is renamed or removed | None | Use existing module-scoped `seed:defaults` operation |
| 14 | Generated-file contracts | Provider modules are added to registries without changing generated shapes | None | Never hand-edit generated output |

### Missing BC Section

The specification includes `Migration & Backward Compatibility` and identifies the preserved import path, default Resend behavior, additive SES provider, and unchanged Inbox Ops boundary.

## Spec Completeness

### Missing Sections

| Section | Impact | Recommendation |
| --- | --- | --- |
| UI/UX | Not applicable: this change has no new operator UI | Record as intentionally omitted |
| Data Models | No new entity or migration is introduced | Record that existing encrypted integration credentials and communication-channel entities are reused |
| Phasing | Implementation and deployment gates are easier to audit when explicit | Execute as provider-neutral transport, provider packages, delivery-path coverage, then FINOO runtime configuration |

### Incomplete Sections

| Section | Gap | Recommendation |
| --- | --- | --- |
| Integration coverage | Categories are named but executable test IDs are not | Keep the existing focused integration cases for auth, customer account, checkout, messages, notifications, sales, security, and onboarding |
| Deployment | Fork runtime variables are intentionally outside the OSS spec | Implement FINOO-specific propagation only in FINOO provision/upgrade automation and keep the generic provider spec fork-neutral |
| Implementation status | The source spec predates this FINOO adoption | Add phase status and exact verification results after implementation |

## AGENTS.md Compliance

### Violations

No design violation was found.

| Rule | Location | Compliance Control |
| --- | --- | --- |
| External providers use dedicated packages | Proposed Solution | Keep `channel-resend` and `channel-ses` under `packages/`; do not place provider code in core |
| Env presets belong to the provider | Architecture | SES region/from/configuration-set parsing and idempotent seeding stay in `channel_ses/setup.ts` and provider helpers |
| Shared has no domain/provider SDK dependency | Architecture | `shared` exposes only the transport registry and provider-neutral send function |
| Tenant and organization scope | API Contracts | Thread trusted scope from each authenticated call site into `sendEmail()` and use scoped encrypted channel/credential reads |
| Secrets and credentials | Architecture | Use the EC2 role credential chain; never store AWS access keys in FINOO env or repository |
| Module setup mirrors ACL | Provider packages | Declare provider view/configure features in both `acl.ts` and `setup.ts` |
| Generated registries | Provider activation | Run `corepack yarn generate`; do not edit generated files manually |

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Existing Resend deployments stop sending | Cross-deployment transactional-email outage | Preserve Resend as the default, enable `channel_resend`, keep env fallback, and run compatibility tests |
| Tenant-scoped invite cannot resolve a SES channel | FINOO invitations still fail after deployment | Enable `channel_ses`, propagate SES env, run idempotent `seed:defaults --module channel_ses`, and read back the connected tenant-wide channel |
| AWS credentials are introduced into app configuration | Secret exposure and long-lived credential risk | Use the already-authorized EC2 IAM role credential chain; add no access keys, secrets, trust-policy, KMS, or IAM writes |

### Medium Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Some email call sites omit tenant scope | Delivery uses pre-tenant fallback rather than the configured tenant channel | Audit all call sites and cover each major delivery path |
| Provider failure is swallowed | UI reports success although SES rejected the message | Preserve synchronous error propagation and assert provider failure behavior |
| Runtime env drifts during rollback | Rollback image cannot reproduce the prior delivery configuration | Upgrade automation must back up and restore `.env` atomically together with container rollback |
| SES sender/configuration mismatch | SES rejects mail | Use verified `no-reply@they.dev`, `eu-west-2`, and no configuration set unless one is explicitly proven |

### Low Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| SES MIME differs from Resend | Formatting or attachment discrepancies | Use Nodemailer SESv2 transport and focused adapter tests |
| Disabled email behavior changes | Local/test environments emit errors | Keep `EMAIL_DELIVERY_DISABLED` behavior and test configuration detection |

## Gap Analysis

### Critical Gaps (Block Implementation)

None. The extension-mode/core decision was explicitly approved, the FINOO runtime is released by THOM-89, SES `they.dev` is verified in `eu-west-2`, and the host role already authorizes `ses:SendEmail` and `ses:SendRawEmail` for that identity.

### Important Gaps (Should Address)

- FINOO env propagation: add `SYSTEM_EMAIL_PROVIDER`, `AWS_SES_REGION`, optional `AWS_SES_CONFIGURATION_SET`, `EMAIL_FROM`, and `NOTIFICATIONS_EMAIL_FROM` to candidate and active runtime construction.
- Seed/read-back: run the provider-owned idempotent seed for every existing FINOO organization and verify the connected tenant-wide SES channel without reading encrypted credentials.
- Controlled acceptance mail: perform one authorized test invitation, verify SES acceptance and recipient delivery, and hand the stable runtime to THOM-89 for final invite-flow read-back.
- Rollback: keep old image, container, `.env`, active commit, and active digest recoverable until headed acceptance succeeds.

### Nice-to-Have Gaps

- Add operational metrics or a SES configuration set later if a current monitoring requirement is approved. It is not required for restoring invitation delivery.

## Remediation Plan

### Before Implementation (Must Do)

1. Import the approved provider-neutral implementation commits onto the exact deployed FINOO SHA and resolve only baseline-specific conflicts.
2. Keep the generic OSS specification unchanged by FINOO-private deployment details.
3. Confirm no changed file enters `apps/mercato/src/modules/finoo_affiliates/**` or the THOM-90 worktree.

### During Implementation (Add to Spec)

1. Record the four implementation phases and test identifiers in `Implementation Status`.
2. Audit every migrated email call site for trusted tenant/organization scope.
3. Add FINOO deployment-script tests or syntax/static checks for SES env propagation and rollback symmetry.

### Post-Implementation (Follow Up)

1. Run focused unit/integration/type/dependency/generator/build gates.
2. Obtain one fresh primary review and one security review.
3. Build an immutable FINOO image, verify revision/digest, deploy through the existing rollback-safe upgrade lane, seed SES, and run controlled acceptance mail.
4. Notify THOM-89 only after FINOO is stable so its final payout-control and invitation read-back can run on the final runtime.

## Recommendation

Ready to implement. Deployment is not ready until code verification and reviews pass; THOM-89 remains the acceptance owner for the final invite-flow read-back.
