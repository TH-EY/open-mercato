## 📸 UI QA evidence — PASS (post-upstream-merge re-verification)

**Verdict:** ✅ PASS · 7/7 browser steps
**Spec:** `.ai/specs/2026-08-25-crm-channel-shared-visibility.md`
**Environment:** `http://127.0.0.1:5001` — ephemeral env (testcontainers Postgres, production build, queue worker), roles created per-run
**Verified:** `contrib/crm-email-sharing` @ `babf787b9` (this PR's current head)

### Why this re-run exists

The previous pass verified `588f49ac8`, which predates merging 292 upstream commits into this branch. Upstream rewrote
`communication_channels/backend/profile/communication-channels/page.tsx` — replacing the `InjectionSpot` connect header with
`ConnectChannelMenu` — and that is the same file carrying this feature's **Team access** column, so it was one of three files whose
merge conflicts had to be resolved by hand.

It also closes a coverage gap the earlier pass declared itself: its fixtures were rows inserted straight into
`customer_interactions`/`communication_channels`, so the Emails tab read "No emails yet" throughout and **thread rendering was never
exercised**. This run builds fixtures through the real compose chain the way `TC-CRM-EMAIL-VISIBILITY-003` does, so the thread is live
and the retroactivity claim is actually observable rather than inferred.

| # | Step | Expected | Observed | Result |
|---|------|----------|----------|--------|
| 1 | Owner opens the Emails tab | Thread renders; share switch present and off | Thread renders with body; switch off, hint "Only you can read your email with this person." | ✅ |
| 2 | Teammate opens the same tab **before** any share | No thread, no badge | "0 conversations / No emails yet"; no badge | ✅ |
| 3 | Owner flips the switch | Confirm dialog naming the consequence | "Share this conversation?" with Cancel / "Share with team" | ✅ |
| 4 | Owner confirms | Switch on | Switch checked | ✅ |
| 5 | Teammate reloads | "Shared by {name}" badge **and** the email sent BEFORE the share | Badge "Shared by QA Merge Owner"; 1 conversation with full body — retroactive grant confirmed | ✅ |
| 6 | Owner flips off (safe direction — no confirm) | Switch off, no dialog | Confirmed | ✅ |
| 7 | Teammate reloads | History clawed back, badge gone | "0 conversations / No emails yet" — reversible and lossless | ✅ |
| 8 | Owner opens Profile → My communication channels | Team access column, alongside upstream's new Connect channel dropdown | Both render together; cell reads "Only you" + "Share with team" | ✅ |
| 9 | Owner shares the mailbox | Confirm dialog, then "Shared" tag + success flash | "Share this mailbox with your team?" → "Shared" tag, flash "Mailbox shared with your team." | ✅ |
| 10 | Owner clicks "Make private" | Reverts to "Only you" | Confirmed | ✅ |

### A bug this pass found and this PR now fixes

**A teammate reading a shared outbound email was shown "You" as the sender** — the colleague's email attributed to the reader.

`EmailThreadsPanel.tsx` labelled every outbound message "You", keyed on message **direction** alone. That was sound when it shipped
(#2424): only the mailbox owner could read their own sent mail, so outbound implied "me". **This feature is precisely what breaks that
premise.** The earlier QA pass could not have caught it, because it never rendered a thread.

The sender could not simply be read off the message either: `send-as-user` writes no `from` into an outbound link's
`channelMetadata`, which is why the label was hardcoded in the first place. So authorship is now carried explicitly —
`buildPersonEmailThreads` passes the interaction's `authorUserId` through as `authoredByViewer` + a resolved `authorName`, and the
panel says "You" only for the viewer's own mail, falling back to the colleague's name → sending address → a generic label.

Authorship is outbound-only: on an inbound message `author_user_id` is the mailbox owner (the *recipient*), so treating it as the
sender would credit the reader with mail their contact sent. A unit test pins that.

Step 5 below is the after-state: the teammate sees **"QA Merge Owner"**. Step 1 confirms the author still reads their own mail as "You".

### Screenshots

**Owner, before sharing** — thread renders, switch off, own message reads "You"
![Owner before share](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-01-owner-emails-before-share.png)

**Teammate, before sharing** — nothing visible (baseline the earlier pass could not assert)
![Teammate before share](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-02-teammate-before-share.png)

**Share confirmation dialog**
![Share confirm](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-03-owner-share-confirm-dialog.png)

**Owner, after sharing**
![Owner after share](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-04-owner-after-share.png)

**Teammate, after sharing** — "Shared by QA Merge Owner" badge, the retroactive history, and the sender correctly credited to the author
![Teammate after share](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-05-teammate-after-share.png)

**Owner, after un-sharing**
![Owner after unshare](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-06-owner-after-unshare.png)

**Teammate, after un-sharing** — access clawed back
![Teammate after unshare](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-07-teammate-after-unshare.png)

**Profile → My communication channels** — Team access column beside upstream's new Connect channel menu
![Profile channels](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-08-profile-channels.png)

**Channel share confirmation**
![Channel share confirm](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-09-channel-share-confirm.png)

**Channel shared** — "Shared" tag + success flash
![Channel shared](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-10-channel-shared.png)

**Channel back to private**
![Channel private](https://raw.githubusercontent.com/TH-EY/open-mercato/qa-evidence-pr-5756/pr-5756/2026-09-23-post-merge/step-11-channel-back-to-private.png)

### Also observed (not fixed here)

At 1280px with the sidebar expanded, the channels table clips its right-hand columns ("Make private", "Status") behind horizontal
overflow — the added Team access column widens the row. The table scrolls, so nothing is unreachable. Cosmetic; flagging rather than
folding an unrelated layout change into this PR.

### Not covered by this pass

Exercised at API level by `TC-CRM-EMAIL-VISIBILITY-003`/`-004`, not re-driven through the browser here: threading-inherited replies
onto a shared conversation, the two-mailbox leak canary, the private-email count, and 409 conflict surfacing on either toggle.

### Fixtures

Self-contained: role, two users, Person, seeded channel and the composed email are created in `beforeAll` and deleted in `afterAll`,
per `.ai/qa/AGENTS.md`. Channel seeding runs through the env-gated `OM_ENABLE_TEST_CHANNEL_SEEDING` path.
