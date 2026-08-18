# THOM-103 final evidence

Evidence date: 2026-08-18 (Europe/Warsaw)  
Implementation commit: `2429cca8d31366f28e42a1290890580ce4e398fb`  
PR: `TH-EY/open-mercato#14`  
Target branch: `fork/finoo`

This branch is evidence-only. It is not part of the implementation PR and must not be merged into `fork/finoo`.

## Automated verification

All successful runs below started by printing the exact implementation SHA and finished with an explicit UTC timestamp and exit code.

| Check | Command | Result | Artifact |
| --- | --- | --- | --- |
| Generated registries | `corepack yarn generate` | PASS | `automated/01-generate.log` |
| App typecheck | `corepack yarn workspace @open-mercato/app typecheck` | PASS | `automated/02-typecheck.log` |
| Focused Jest | `corepack yarn workspace @open-mercato/app test --runInBand --testPathPatterns='src/modules/finoo_(affiliates\|intermediaries)' --testPathIgnorePatterns='__integration__'` | PASS, 59/59 suites and 284/284 tests | `automated/03-focused-jest.log` |
| Package build | `corepack yarn build:packages` | PASS, 23/23 tasks | `automated/04-build-packages.log` |
| Diff whitespace | `git diff --check origin/fork/finoo...HEAD` | PASS | `automated/05-diff-check.log` |
| Focused integration | `corepack yarn exec playwright test --config .ai/qa/tests/playwright.thom103-final.config.ts` against a fresh ephemeral database and exact reusable harness environment | PASS, 7/7 Playwright tests | `automated/07-playwright-focused-exact-env.log`, `automated/07-playwright-results.json` |

The focused Playwright configuration used for the final run is preserved as `automated/playwright.thom103-final.config.ts`. The seven Playwright tests contain the grouped payout, privacy, optimistic-locking, atomic bulk assignment, replay/no-op, reassign-confirmation, inactive/stale-state, tenant-scope, and late rollback cases added or extended by THOM-103.

An earlier manual invocation on the same SHA omitted the ephemeral harness email-capture credentials and therefore failed in fixture cleanup. That run was rejected as invalid harness evidence. The exact environment was then reconstructed from the running repository harness, the automatic queue worker was stopped so the explicit queue-drain assertions owned the local queues, and the full focused run passed 7/7 without retries.

## Deployment binding

- ECR digest: `sha256:dffd7fb0944a0d47013f58a0c0fa63d6ddf93fc0c3f302c6073beec224b63c52`
- OCI revision label: `2429cca8d31366f28e42a1290890580ce4e398fb`
- Runtime image read-back matched both values after deployment.
- `https://finoo.om.they.dev/login` returned HTTP 200.

## Headed runtime QA

The headed session used the deployed image above and the Finoo tenant. All QA data used deterministic identifiers and was removed after read-back.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Affiliate bank-account readiness, desktop and narrow viewport | PASS | `runtime/02-affiliates-readiness-desktop.png`, `runtime/03-affiliates-readiness-narrow.png` |
| Mixed selection: three transactions for two affiliates | PASS; preview grouped into exactly two transfers, then exactly two payout rows were recorded | `runtime/05-payout-grouped-preview-desktop.png`, `runtime/06-payout-grouped-preview-narrow.png`, `runtime/08-payouts-grouped-records-desktop.png` |
| Incomplete bank profile | PASS; preview returned 409 and the localized UI named the affiliate and missing account number; no payout write | `runtime/13-payout-incomplete-error-final.png` |
| Same affiliate: two transactions | PASS; preview showed 1 affiliate, 2 transactions, 10000 PLN; final DB read-back was `1 payout / 10000 / 1 affiliate`, `2 transactions / 1 payout_id / paid_out`, progress `completed / 100` | `runtime/17-same-affiliate-preview-success-final.png`, `runtime/18-same-affiliate-progress-success-final.png`; SSM read-back command `240b3244-63c6-4382-b187-ca46a7ac2e68` |
| Dialog keyboard behavior | PASS; `Escape` cancelled without a confirm request, then `Cmd+Enter` submitted the same-affiliate confirmation and produced HTTP 202 | same-affiliate screenshots and recorded request summary in the PR/Jira evidence comment |
| Bulk assignment route and selection | PASS; three selected Deals reached the dedicated page with the exact selection | `runtime/10-bulk-assignment-page-desktop.png` |
| Exact no-op and explicit reassignment confirmation | PASS; same intermediary created no receipt, different intermediary required confirmation and reassigned exactly three Deals without duplicates | `runtime/11-bulk-reassignment-confirm-desktop.png`, `runtime/12-bulk-reassignment-confirm-narrow.png` |
| Blocked/all-or-nothing, stale state, inactive target, tenant scope, RBAC, replay | PASS in self-contained Playwright and focused Jest; mutations rolled back atomically | automated logs and JSON result |
| Retry-terminal progress | PASS; production queue trace showed attempt 1/3 and 2/3 remained retryable, and terminal failed state was emitted only after attempt 3/3 exhausted. The subsequent valid same-affiliate run reached `completed / 100`. | production log read-back plus successful SSM DB read-back above |

## Cleanup

- Prior multi-affiliate and bulk-assignment fixtures: SSM command `3fb93ca6-da99-4500-834a-18dd5273b6a7`, all listed fixture tables read back as zero.
- Final same-affiliate fixture: SSM command `b2945d55-8f7a-4ba3-82bd-e64bebc23f16`, read-back: `transactions|0`, `payouts|0`, `affiliates|0`, `progress|0`.
- The ephemeral Playwright database/container was stopped and its state file was cleared.

## Notes

- The payout action records transfers already executed outside Open Mercato. It does not initiate bank transfers.
- The production retry trace was triggered by a deliberately invalid synthetic fixture and was cleaned. No customer record was involved.
- HAR files are intentionally not committed because they can contain authenticated headers and cookies. Only status-level request summaries are retained.
