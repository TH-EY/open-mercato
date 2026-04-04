# OpenMercato CSV import recovery checkpoint — 2026-04-04

## Goal
Preserve the exact implementation/deployment state so another AI agent can resume the AWS recovery and final deploy.

## Local code state
CSV import hardening changes are present in the working tree:
- sync_excel batch size reduced to 25
- heartbeat/progress emitted during batch processing (every 5 rows)
- per-row vector/fulltext indexing suppressed during import
- deferred bulk reindex scheduled after import
- Redis ElastiCache parameter group change to `maxmemory-policy: noeviction`
- CloudFormation WebService hardening patch added: `HealthCheckGracePeriodSeconds: 120` and `DeploymentConfiguration.DeploymentCircuitBreaker = { Enable: true, Rollback: true }`

Key files touched include:
- `packages/core/src/modules/data_sync/lib/batch-size.ts`
- `packages/core/src/modules/sync_excel/lib/adapters/customers.ts`
- `packages/core/src/modules/customers/commands/shared.ts`
- `packages/core/src/modules/customers/commands/people.ts`
- `packages/core/src/modules/customers/commands/addresses.ts`
- `packages/core/src/modules/data_sync/lib/adapter.ts`
- `packages/core/src/modules/data_sync/lib/sync-engine.ts`
- `packages/core/src/modules/data_sync/di.ts`
- `packages/core/src/modules/data_sync/lib/start-run.ts`
- `packages/core/src/modules/data_sync/api/runs/[id]/retry.ts`
- `packages/core/src/modules/sync_excel/api/import/route.ts`
- `packages/core/src/modules/sync_excel/data/validators.ts`
- `packages/core/src/modules/query_index/subscribers/upsert_one.ts`
- `packages/core/src/modules/query_index/subscribers/delete_one.ts`
- `packages/search/src/modules/search/subscribers/vector_delete.ts`
- `packages/shared/src/lib/data/engine.ts`
- `infra/cloudformation/openmercato.yml`
- `.ai/specs/2026-03-29-sync-excel-customers-import-foundation.md`

## Verification already completed
Previously passed before this checkpoint:
- `packages/core/src/modules/sync_excel/lib/__tests__/customers-adapter.test.ts`
- `packages/core/src/modules/data_sync/lib/__tests__/sync-engine-import-failures.test.ts`
- `packages/core/src/modules/query_index/subscribers/__tests__/upsert_one.test.ts`
- TypeScript check: `node ./node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --noEmit`
- CloudFormation template validation passed for `infra/cloudformation/openmercato.yml`

## Image already built and pushed
- AWS account: `062648047691`
- region: `eu-west-2`
- ECR repo: `062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app`
- pushed tag: `csv-import-20260402-213945`
- `latest` also points to the same digest
- digest: `sha256:a78b5d6e96f07ebf9d12c676477ac0de0cfc5395d66f3cbbfc39ee596dc914e7`

## AWS recovery history
1. Stack `openmercato` originally sat in `UPDATE_ROLLBACK_FAILED`
2. Ran `continue-update-rollback --resources-to-skip WebService` and recovered it to `UPDATE_ROLLBACK_COMPLETE`
3. Deployed current template/image; Redis changes applied and runtime looked healthy
4. CloudFormation got stuck on `WebService` in `UPDATE_IN_PROGRESS` / `NotStabilized`
5. Researched official AWS docs (Context7) and added long-term ECS service mitigations: circuit breaker + health-check grace period
6. Because the stack was still busy, ran `cancel-update-stack`
7. Stack moved to `UPDATE_ROLLBACK_IN_PROGRESS` and stayed there
8. Also attempted targeted operational recovery:
   - force new deployment / restart of web service
   - ALB target deregistration for stale targets
   - temporary target group attribute change: `deregistration_delay.timeout_seconds = 0`

## Current AWS status at checkpoint
- CloudFormation stack: `openmercato`
- stack status: `UPDATE_ROLLBACK_IN_PROGRESS`
- main blocker resource: `WebService`
- production URL still healthy: `https://openmercato.they.dev/` returns HTTP 200
- ECS web currently on rollback task definition: `openmercato-web:11`
- ECS worker currently on rollback task definition: `openmercato-worker-worker:8`
- worker service looked stable; web runtime looked healthy even while CloudFormation remained stuck

## Helpful resource details
- target group ARN: `arn:aws:elasticloadbalancing:eu-west-2:062648047691:targetgroup/openmercato-they-tg/151040b5443efa2c`
- one stale/draining target previously observed: `10.1.1.133:3000`
- healthy target later observed: `10.1.1.97:3000`

## Recommended next step for the next agent
1. Check the current stack status for `openmercato`
2. If the stack becomes `UPDATE_ROLLBACK_COMPLETE`, immediately deploy the current template so the WebService gets:
   - `HealthCheckGracePeriodSeconds: 120`
   - `DeploymentCircuitBreaker.Enable: true`
   - `DeploymentCircuitBreaker.Rollback: true`
3. If the stack instead becomes `UPDATE_ROLLBACK_FAILED`, use the official AWS recovery path:
   - `continue-update-rollback --resources-to-skip WebService`
4. Once the stack is stable again, deploy the current image/template combination and verify:
   - CloudFormation reaches a terminal success state
   - ECS web switches off rollback task definition 11
   - production URL returns 200
   - CSV import completes without stale heartbeat failure

## Important context for git checkpoint
The working tree contains broader in-progress repository changes beyond the CSV import files. The user explicitly requested saving the current state so another AI agent can resume later.