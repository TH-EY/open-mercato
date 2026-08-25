# Run: CRM Channel Visibility Flag

**Engine:** om-auto-create-pr (steps: 14, --loop: no)
**Branch:** `feat/crm-channel-visibility-flag`
**Base:** `feat/crm-channel-shared-visibility` (stacked on PR #23; retargets to `fork/crm-they-dev` when #23 merges)
**Status:** in-progress

## Goal

Let a personal-mailbox owner mark the **whole channel** as shared, so every CRM-linked email that mailbox ingests becomes readable by the team — the "this is a team mailbox" capability. Complements the per-Person conversation share from PR #23; neither replaces the other.

## Why this is a real gap (corrects PR #23's Q1 reasoning)

When I decided Q1 on PR #23 I assumed a workaround existed — "connect the mailbox as a tenant-wide channel instead". **That workaround does not exist for email.** Verified:

- `connect/credentials` (IMAP) hardcodes `userId: auth.sub` (route.ts:90). Always personal.
- `oauth/[provider]/initiate` (Gmail) likewise sets `userId: auth.sub` (route.ts:125). Always personal.
- `connect/tenant-credentials` — the only route producing `user_id IS NULL` — is documented as *"Connect a tenant-wide credential-based channel (push: FCM/APNs/Expo)"*, and its only UI callers are `channel-fcm`, `channel-apns`, `channel-expo`. `communication_channels.connect_tenant_channel`'s ACL comment says the same: shared **push** credentials.

So tenant-wide is a push-only concept. An email mailbox can only ever be personal/private, and there is currently no mechanism at any level to make one team-visible. That makes this a substantive feature, not a redundant convenience.

## Design

**Channel flag.** `CommunicationChannel.visibility` (`private` | `shared`), default `private`, with the same-migration `UPDATE ... SET visibility='shared' WHERE user_id IS NULL` so existing tenant-wide push channels keep working. Without that UPDATE the column addition would silently un-share every FCM/APNs/Expo channel on deploy.

**Interaction → channel resolution requires denormalisation.** PR #23 avoided this by keying its grant on `author_user_id`. That trick does **not** work here: an owner with one shared and one private mailbox would have the private one's mail exposed too, because `author_user_id` is the same for both. So this run adds `customer_interactions.channel_id uuid null`, written at ingestion (the handler already resolves the channel) and backfilled once via the only available chain:

```
customer_interactions.external_message_id → message_channel_links.id
message_channel_links.external_conversation_id → external_conversations.id
external_conversations.channel_id → communication_channels.id
```

Verified: `message_channel_links` has **no** `channel_id`, so there is no shorter path. The read arm then matches one indexed column instead of a three-join hop.

**Read-time derivation, not write-time.** Ingestion is deliberately left alone — `resolveVisibility()` keeps returning `private` for user-scoped channels. Flipping a channel to shared widens what the read filter admits; it never rewrites `customer_interactions.visibility`. That keeps un-sharing instant and lossless, and keeps `entity_indexes` consistent (the one-way-door hazard the PR #23 spec logged as R4).

## Scope

- `packages/core/src/modules/communication_channels/` — the `visibility` column, migration, ACL feature, event, command, owner-only PATCH, profile-page toggle.
- `packages/core/src/modules/customers/` — `channel_id` denormalisation + backfill + index, the new predicate arm, and the shared-channel lookup wired into every email read path.

## Non-goals

- No change to ingestion defaults (`resolveVisibility` untouched) — read-time derivation only, so flipping back is lossless.
- No admin escalation. Only the channel **owner** may flip it; `communication_channels.admin` and `customers.email.view_private` stay inert.
- No tenant-wide email connect flow — that stays push-only.
- No per-channel-per-Person interaction (a shared channel shares all its CRM email; a private channel can still share one conversation via PR #23).

## Risks

- **Over-exposure is the failure mode.** Mitigated by matching on the denormalised `channel_id` (exact, per-channel) rather than `author_user_id` (would leak sibling mailboxes), and by every new predicate option defaulting fail-closed.
- **Backfill correctness.** A wrong join would attribute email to the wrong channel. The backfill is a single deterministic `UPDATE ... FROM` over the verified chain, and rows that cannot resolve stay `NULL` (which the predicate treats as not-shared — fail closed).
- **Migration default.** `DEFAULT 'private'` plus the same-migration UPDATE for `user_id IS NULL`; asserted by test.
- Stacked on an unmerged PR, so the diff must be read against `feat/crm-channel-shared-visibility`.

## Implementation Plan

### Phase 1: Interaction → channel resolution

- 1.1 Add `customer_interactions.channel_id` to the entity and extend the email-visibility partial index to cover it
- 1.2 Write channel_id at ingestion
- 1.3 Migration: add column, extend index, backfill via the verified chain; update the customers snapshot

### Phase 2: Channel visibility flag

- 2.1 Add CommunicationChannel.visibility with the same-migration UPDATE for tenant-wide rows; update the channels snapshot
- 2.2 Declare the ACL feature, setup grant, and the channel visibility_changed event
- 2.3 Add the command and the owner-only PATCH route with optimistic locking

### Phase 3: Read widening

- 3.1 Add a fail-closed sharedChannelIds arm to both predicates and the hidden-email complement
- 3.2 Add the shared-channel lookup service and wire it into every email read path

### Phase 4: UI and i18n

- 4.1 Add the channel shared/private toggle with confirm dialog to the profile channels page
- 4.2 Add i18n keys to all five locale files

### Phase 5: Tests and gate

- 5.1 Unit tests for the channel arm, the fail-closed default, and the migration default rule
- 5.2 Integration test TC-CRM-EMAIL-VISIBILITY-004
- 5.3 Run the full validation gate and fix fallout

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Interaction → channel resolution

- [x] 1.1 Add customer_interactions.channel_id and extend the partial index — 5478094ea
- [x] 1.2 Write channel_id at ingestion — 5478094ea
- [x] 1.3 Migration with backfill and snapshot — 5478094ea

### Phase 2: Channel visibility flag

- [x] 2.1 Add CommunicationChannel.visibility with the tenant-wide UPDATE — 65d36b0dd
- [x] 2.2 ACL feature, setup grant, event — 65d36b0dd
- [x] 2.3 Command and owner-only PATCH route — 65d36b0dd

### Phase 3: Read widening

- [x] 3.1 Add the fail-closed sharedChannelIds arm to both predicates — c1fd6af98
- [x] 3.2 Shared-channel lookup wired into every email read path — c1fd6af98

### Phase 4: UI and i18n

- [x] 4.1 Channel toggle on the profile channels page — 1205b3acf
- [x] 4.2 i18n keys in all five locales — 1205b3acf

### Phase 5: Tests and gate

- [x] 5.1 Unit tests — c1fd6af98
- [ ] 5.2 Integration test TC-CRM-EMAIL-VISIBILITY-004
- [ ] 5.3 Full validation gate
</content>
