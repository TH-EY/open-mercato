# THOM-103 final evidence

Evidence date: 2026-08-18 (Europe/Warsaw)
Implementation commit: `a5eb83110b71e546e44c9d387a20f840442330be`
PR: `TH-EY/open-mercato#14`
Target branch: `fork/finoo`

This branch is evidence-only. It is not part of the implementation PR and must not be merged into `fork/finoo`.

## Automated verification

Every successful log below prints the exact implementation SHA, UTC timestamps, and an explicit exit code.

| Check | Command | Result | Artifact |
| --- | --- | --- | --- |
| Generated registries | `corepack yarn generate` | PASS | `automated/01-generate.log` |
| App typecheck | `corepack yarn workspace @open-mercato/app typecheck` | PASS | `automated/02-typecheck.log` |
| Module lint | `corepack yarn workspace @open-mercato/app lint -- src/modules/finoo_affiliates src/modules/finoo_intermediaries` | PASS | `automated/03-lint.log` |
| Focused Jest | `corepack yarn workspace @open-mercato/app test --runInBand --testPathPatterns='src/modules/finoo_(affiliates|intermediaries)' --testPathIgnorePatterns='__integration__'` | PASS, 61/61 suites and 288/288 tests | `automated/04-focused-jest.log` |
| Package build | `corepack yarn build:packages` | PASS, 23/23 tasks | `automated/05-build-packages.log` |
| Diff whitespace | `git diff --check origin/fork/finoo...HEAD` | PASS | `automated/06-diff-check.log` |
| Focused integration | `corepack yarn exec playwright test --config .ai/qa/tests/playwright.thom103-final.config.ts --workers=1` against the fresh ephemeral repository harness | PASS, 7/7 Playwright tests | `automated/07-playwright-focused-exact-env.log`, `automated/07-playwright-results.json` |

The preserved Playwright configuration selects the payout and intermediary bulk-assignment integration suites only. The final run used the harness-provided database, queue directory, email-capture paths and process-only capture tokens. The supervisor-owned queue worker was paused (`T+`) during the run so each test's explicit queue drain owned job execution. The ephemeral server, worker, database container, port 5001 and environment file were removed after the run.

Two preliminary runs are intentionally excluded from the evidence set: the first omitted the harness queue directory, and after that correction the supervisor respawned a terminated worker that consumed replay jobs before the test-owned drain. Both diagnostics were rejected; no product code was changed for those environment faults. The bound run above passed 7/7 without retries.

## Deployment binding

- ECR image tag: `finoo-a5eb83110b71e546e44c9d387a20f840442330be`
- ECR index digest: `sha256:801c78b42d1f28f156c73f0983d92f54a720330e00113f6174a86890ac400f24`
- OCI revision: `a5eb83110b71e546e44c9d387a20f840442330be`
- SSM deployment completed successfully and the migration, Finoo SES health check, superadmin smoke, employee smoke and existing-admin-role smoke passed.
- Independent SSM read-back command `225db7f5-95ea-4610-a298-76e32a64f010` returned the exact commit, digest, running container, digest-pinned image, OCI revision and local HTTP 200.
- Fresh ECR/SSM/ALB/public read-back at `2026-08-18T20:34:23Z` returned the exact digest, healthy target and public HTTP 200.

Artifacts: `deployment/01-host-readiness.log`, `deployment/02-deploy.log`, `deployment/03-runtime-binding-readback.log`.

## Runtime QA on the final deployment

The final headed regression session used the deployed image above and the Finoo tenant. Synthetic financial fixtures used deterministic identifiers and were removed after database read-back.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Blocked bulk-selection reasons | PASS; the UI distinguishes an ineligible stage from a missing/out-of-scope Deal in Polish, at desktop and narrow widths | `runtime/19-final-bulk-blocked-reasons-desktop.png`, `runtime/20-final-bulk-blocked-reasons-narrow.png` |
| Duplicate bulk-assignment shortcut | PASS; two rapid `Cmd+Enter` presses produced exactly one POST; the existing assignment remained a safe no-op | `runtime/21-final-bulk-double-shortcut-network.json` |
| Same affiliate, two transactions | PASS; preview showed one affiliate, two transactions and 100 PLN at desktop and narrow widths | `runtime/22-final-same-affiliate-preview-desktop.png`, `runtime/23-final-same-affiliate-preview-narrow.png` |
| Duplicate payout shortcut | PASS; two rapid `Cmd+Enter` presses produced exactly one confirm POST with HTTP 202 | `runtime/24-final-payout-double-shortcut-network.json` |
| Grouped payout persistence | PASS; DB read-back returned one payout for 100 PLN and two paid-out transactions with the same payout ID | `runtime/25-final-payout-record.png`, `deployment/04-runtime-qa-db-readbacks.log` |
| Progress terminal state | PASS; DB read-back before cleanup returned `completed`, 100%, 2/2 | `deployment/04-runtime-qa-db-readbacks.log` |
| Cleanup | PASS; exact transaction, preview, payout and progress counts all read back as zero | SSM cleanup command `841b16e4-3da0-4f5c-a970-8302d2b9e08b`, captured in `deployment/04-runtime-qa-db-readbacks.log` |

The earlier screenshots retained in `runtime/02-*` through `runtime/18-*` cover the broader pre-final headed matrix: affiliate readiness, mixed two-affiliate grouping, localized incomplete-profile error, selected Deal routing, no-op assignment, and explicit reassignment confirmation. The final commit changed the duplicate-submit guards, explicit blocked-reason rendering and DI-aware optimistic-lock guard; those exact deltas are covered on the final deployment above and by the current-head unit/integration suites.

## Contract and negative-path coverage

The current-head Playwright and focused Jest artifacts cover the server-side paths that are not safely reproduced against shared production data: invalid transaction status/currency/already-paid selection, incomplete profile without writes, tenant and organization scope, RBAC, stale optimistic state, inactive intermediary, confirmation-required reassignment, all-or-nothing rollback, exact replay/no-op, retryable versus terminal worker failure, and receipt-based convergence after a committed operation.

## Notes

- A payout records transfers executed outside Open Mercato; it does not initiate bank transfers.
- HAR files are intentionally excluded because they can contain authenticated headers and cookies. The committed request summaries contain no cookie or authorization header.
- The evidence branch preserves previous evidence commits for audit history; this README and its checksums describe the final `a5eb831` evidence set.
