# crm.they.dev AWS Observability

## TLDR

**Key points:**

- Centralize private `crm.they.dev` operational logs in AWS without replacing the EC2 host or changing application APIs.
- Preserve the already-live app/worker CloudWatch resources, extend the same contract to every CRM container, SSM commands, host logs, and RDS PostgreSQL logs.

**Scope:**

- `crm.they.dev` only; no upstream contribution and no changes to other environments.
- Terraform-owned log groups and retention, least-privilege runtime permissions, Docker `awslogs`, CloudWatch Agent configuration through SSM, RDS native exports, deployment verification, and rollback.

**Concerns:**

- The live Terraform state contains drift that makes an unrestricted apply destructive, including an EC2 replacement. Only reviewed observability targets or exact AWS API mutations may be applied.
- `they-lb` is shared. ALB access logging is configured at load-balancer scope, so enabling it would capture traffic outside `crm.they.dev` and is excluded by the private-instance boundary.

## Overview

Open Mercato already emits structured operational logs to stdout. The runtime documentation states that production emits Pino JSON and the deployment wires the collector. This change supplies that deployment-owned aggregation layer while retaining database audit logs as a separate business-level facility.

The design follows the official Docker `awslogs` contract, AWS Systems Manager and CloudWatch Agent installation model, and RDS native PostgreSQL export. It deliberately does not port the newer optional Open Mercato telemetry package into the older CRM fork because log aggregation works against the existing stdout contract and does not require an application-layer upgrade.

## Problem Statement

- CRM containers use local Docker `json-file` logging. Meilisearch has already produced hundreds of megabytes locally and no rotation policy is configured.
- SSM Run Command requests CloudWatch output at `/aws/ssm/openmercato-crm-they-dev/deploy`, but the group is absent and the instance role lacks required discovery permissions. Commands can succeed while the CloudWatch output publisher fails.
- The EC2 host has no centralized syslog/auth log collector.
- RDS PostgreSQL log export is disabled.
- Existing app and worker CloudWatch groups and stream-write permissions are present in Terraform state and AWS, but absent from the current fork. An unrestricted plan would delete those groups, remove unrelated live secret access, and replace the EC2 instance.
- The shared ALB has access, connection, and health-check logging disabled. AWS configures these at ALB scope, not by listener rule or target group, so enabling them would collect traffic for services outside the authorized CRM boundary.

## Proposed Solution

1. Restore the state-owned app and worker log groups to source control and add dedicated groups for Redis, Meilisearch, MCP, OpenCode, host logs, SSM output, and RDS `postgresql`/`upgrade` exports.
2. Give every group an explicit retention period and `skip_destroy = true` so a later configuration rollback cannot erase retained evidence.
3. Apply a per-group data protection policy that audits and masks AWS secret keys, email addresses, and common private-key formats for newly ingested events. Source-side minimization remains the primary control.
4. Extend the existing EC2 inline policy without removing current secret access. Docker and CloudWatch Agent receive `CreateLogStream`, `DescribeLogStreams`, and `PutLogEvents` only on the exact groups. `DescribeLogGroups` remains account-scoped because AWS does not support group-level resource scoping for that discovery call.
5. Configure all six Compose services with the `awslogs` driver, precreated groups, a unique `{{.Name}}/{{.ID}}` stream tag, non-blocking delivery, and an explicit 8 MiB buffer. Operational log loss during a prolonged CloudWatch outage is accepted in preference to blocking CRM processes; business audit records remain in PostgreSQL.
6. Install and configure the CloudWatch Agent through SSM associations targeted by the CRM EC2 `Name` tag. Collect `/var/log/syslog` and `/var/log/auth.log` into separate streams in the host group. Do not modify `user-data.sh`, because that would replace the host and risk Docker-local volumes.
7. Enable RDS `postgresql` and `upgrade` exports. AWS documents this setting as immediate and no-downtime. Use an exact RDS API change if the full Terraform resource plan still contains unrelated drift.
8. Recreate only the active CRM services after log groups and IAM are ready, then verify CloudWatch events, SSM output, RDS export state, container health, ALB target health, and the authenticated CRM UI.

### Design Decisions

| Decision | Rationale |
| --- | --- |
| Deployment aggregation, not application telemetry upgrade | Current CRM already emits structured stdout; the Open Mercato telemetry spec explicitly leaves aggregation to deployments. |
| One CloudWatch group per container service | Makes service queries, retention, and IAM boundaries explicit while preserving the existing app/worker resource addresses. |
| Precreated groups; no driver-side creation | Terraform owns retention/tags and the EC2 role does not need `CreateLogGroup`. |
| Non-blocking Docker delivery with 8 MiB buffer | Prevents a CloudWatch outage from blocking application writes; bounded loss is an explicit residual risk. |
| SSM associations instead of EC2 user data | Configures the existing host in place and avoids instance replacement. |
| No ALB log mutation | The ALB is shared and has no listener/target-group-level logging boundary. |
| Per-group sensitive-data masking | Protects newly ingested common credentials and email addresses while retaining source-side minimization as the primary control. |
| Targeted apply or exact AWS API calls only | The current full plan is unsafe and includes resources outside THOM-92. |

### Alternatives Considered

| Alternative | Why rejected |
| --- | --- |
| Port `@open-mercato/telemetry` and OTLP into the CRM fork | Broader application/runtime upgrade than required for logs and not present at the CRM base commit. |
| CloudWatch Agent tails Docker JSON files | Keeps large local JSON files and couples collection to Docker filesystem internals. The native driver removes that unbounded path. |
| Change Docker daemon default driver | Host-wide change would affect unrelated containers and require daemon restart. Per-service Compose config is narrower. |
| Enable shared ALB access logs and filter downstream | Captures and stores non-CRM traffic, exceeding the explicit instance-only authorization. |
| Unrestricted `tofu apply` | Current plan would replace EC2 and mutate unrelated RDS, security-group, tag, secret, and branch state. |

## User Stories / Use Cases

- An operator can query recent app, worker, MCP, Redis, and Meilisearch failures in CloudWatch without SSM access to the host.
- An operator can inspect SSM deployment output after a GitHub runner has terminated.
- An operator can correlate host authentication/system events and RDS PostgreSQL events with a CRM incident.
- A deployer can roll back Compose logging without deleting retained CloudWatch history.

## Architecture

```text
app / worker / redis / meilisearch / mcp / opencode
  stdout + stderr
      -> Docker awslogs driver (EC2 instance profile)
          -> dedicated CloudWatch Logs groups

/var/log/syslog + /var/log/auth.log
      -> CloudWatch Agent installed/configured by SSM associations
          -> /openmercato/crm/host

SSM Run Command stdout + stderr
      -> SSM Agent
          -> /aws/ssm/openmercato-crm-they-dev/deploy

RDS PostgreSQL engine logs
      -> RDS native export
          -> /aws/rds/instance/openmercato-crm-they-dev-postgres/{postgresql,upgrade}
```

Terraform owns destinations, retention, the agent configuration parameter, associations, and least-privilege permissions. Compose owns container routing. RDS owns engine delivery. ALB access logs remain disabled because the collection boundary is the shared load balancer.

## Data Models

N/A. No application entity, database schema, tenancy rule, or business audit record changes.

## API Contracts

N/A. No Open Mercato HTTP, CLI, event, DI, ACL, or module contract changes.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `cloudwatch_log_retention_days` | `30` | Container, host, and RDS group retention. |
| `ssm_log_retention_days` | `14` | Deployment/diagnostic command output retention. |
| Compose `mode` | `non-blocking` | Protect process availability during delivery failure. |
| Compose `max-buffer-size` | `8m` | Bound the per-container non-blocking delivery buffer. |

Log groups:

- `/openmercato/crm/app`
- `/openmercato/crm/worker`
- `/openmercato/crm/redis`
- `/openmercato/crm/meilisearch`
- `/openmercato/crm/mcp`
- `/openmercato/crm/opencode`
- `/openmercato/crm/host`
- `/aws/ssm/openmercato-crm-they-dev/deploy`
- `/aws/rds/instance/openmercato-crm-they-dev-postgres/postgresql`
- `/aws/rds/instance/openmercato-crm-they-dev-postgres/upgrade`

## Migration & Compatibility

- Existing app/worker Terraform addresses and group names are preserved, so no state move or log deletion is required.
- Existing live OpenRouter and MCP secret access is represented through read-only Secrets Manager data sources before the runtime IAM policy is touched.
- Docker logging changes require container recreation but not image rebuild, data migration, or volume replacement.
- Redis and Meilisearch named volumes remain attached during recreation.
- OpenCode receives the logging configuration but is not started by this task while its local image lifecycle remains unresolved.
- Both standalone deployment modes use the explicit active set `app`, `worker`, `mcp`, `redis`, and `meilisearch`; neither starts OpenCode.
- RDS exports are enabled independently from other pending `aws_db_instance` drift.
- No ALB, listener, target group, DNS, EC2, volume, database network, or public-access setting is changed.

## Implementation Plan

### Phase 1: Source and contract recovery

1. Add a focused Node contract test that initially fails for missing log groups, IAM actions, Compose logging, and deployment recreation coverage.
2. Restore existing app/worker resources and current secret-policy dependencies to HCL.
3. Add remaining groups, retention, permissions, CloudWatch Agent parameter/associations, and RDS exports.

### Phase 2: Runtime routing

1. Add `awslogs` configuration to every Compose service.
2. Make standalone SSM deployments publish output to the same managed group as the GitHub workflow. Compose remains the single container-routing source for both deployment paths.
3. Document CloudWatch locations, validation, ALB boundary, and rollback.

### Phase 3: Verification and deployment

1. Run the focused test, full script tests, Compose rendering, shell syntax, Terraform format/validate, and exact targeted plans.
2. Obtain deep and security reviews; resolve findings and rerun checks.
3. After explicit approval of the IAM/storage plan, apply exact log-group/IAM/agent/RDS changes and deploy the private branch.
4. Verify new events and service health, run headed authenticated QA, attach durable Jira evidence, and obtain release-evidence review before closing THOM-92.

### File Manifest

| File | Action | Purpose |
| --- | --- | --- |
| `.ai/specs/2026-08-14-crm-they-dev-aws-observability.md` | Create | Private-fork architecture, boundaries, rollout, and rollback. |
| `infra/terraform/modules/single_ec2_rds_crm/main.tf` | Modify | Log groups, IAM, agent config/associations, RDS exports. |
| `infra/terraform/modules/single_ec2_rds_crm/variables.tf` | Modify | Retention inputs. |
| `infra/terraform/environments/crm-they-dev/main.tf` | Modify | Pass retention inputs. |
| `infra/terraform/environments/crm-they-dev/variables.tf` | Modify | CRM retention defaults. |
| `docker-compose.crm.yml` | Modify | Per-service `awslogs` routing. |
| `scripts/crm/deploy-crm-they-dev.sh` | Modify | Publish standalone SSM deployment output to the managed group. |
| `scripts/__tests__/crm-observability.test.mjs` | Create | Static operational contract regression test. |
| `infra/terraform/environments/crm-they-dev/README.md` | Modify | Operator locations, retention, deployment, and rollback. |

### Testing Strategy

- `node --test scripts/__tests__/crm-observability.test.mjs`
- `corepack yarn test:scripts`
- `docker compose --env-file /dev/null -f docker-compose.crm.yml config --no-interpolate --quiet`
- `bash -n scripts/crm/deploy-crm-they-dev.sh scripts/crm/ssm-run-step.sh`
- `tofu fmt -check -recursive infra/terraform`
- `tofu validate` in the initialized CRM environment.
- Full read-only plan plus exact targeted plans; reject any EC2/RDS replacement, log deletion, or unrelated policy removal.
- AWS readback: group retention, IAM JSON, association status, RDS export state, recent log events, SSM publisher errors, and container driver config.
- Headed authenticated CRM QA after public `/login` smoke and healthy ALB target.

## Risks & Impact Review

### Data Integrity Failures

No application data is mutated. Container recreation preserves named volumes. An unrestricted Terraform apply could replace EC2 and lose Docker-local data, so it is prohibited.

### Cascading Failures & Side Effects

CloudWatch delivery failure can drop operational events after the non-blocking buffer fills. It does not stop CRM processes. RDS and business audit writes do not depend on CloudWatch.

### Tenant & Data Isolation Risks

This is a single-company environment. Log fields can still contain sensitive data if a process writes it. The application logger redacts common secret keys, but operators must not log payload bodies or credentials. Access to the groups remains governed by AWS IAM.

### Migration & Deployment Risks

All active containers need recreation for a new log driver. Redis/Meilisearch restart briefly and retain named volumes. The rollout order is destinations, IAM, agent/RDS, then containers; rollback reverses Compose first and retains log groups.

### Operational Risks

CloudWatch costs grow with ingestion and retention. Thirty-day container/host/RDS and fourteen-day SSM retention bound storage. ALB request logs remain a documented gap because enabling them would exceed the CRM-only scope.

#### Unrestricted Terraform plan replaces EC2

- **Scenario**: A normal apply resolves current AMI and configuration drift by replacing the only EC2 host and target attachment.
- **Severity**: Critical
- **Affected area**: CRM availability and Docker-local Redis, Meilisearch, attachments, and init-marker volumes.
- **Mitigation**: Do not modify user data; use exact targets/API operations; save and review plans; reject any replacement action.
- **Residual risk**: Future general Terraform reconciliation still requires a separate drift-remediation task.

#### Runtime IAM update removes live secret access

- **Scenario**: Applying the stale policy removes OpenRouter/MCP secret ARNs and breaks AI/MCP runtime behavior.
- **Severity**: High
- **Affected area**: CRM AI and MCP services.
- **Mitigation**: Represent both existing secrets as data sources, compare the target plan and post-apply policy JSON, and preserve every existing statement.
- **Residual risk**: Other out-of-band policy changes after planning require a fresh plan/readback.

#### Container log delivery drops events

- **Scenario**: CloudWatch is unavailable long enough to fill an 8 MiB per-container buffer.
- **Severity**: Medium
- **Affected area**: Operational diagnostics only.
- **Mitigation**: Non-blocking delivery protects CRM, monitor delivery errors, retain business audit logs separately, and size the buffer above Docker's default.
- **Residual risk**: Events beyond the buffer are intentionally dropped.

#### Logs contain sensitive fields

- **Scenario**: A service writes credentials, payload bodies, or PII to stdout/stderr and CloudWatch retains it.
- **Severity**: High
- **Affected area**: CloudWatch Logs confidentiality.
- **Mitigation**: Preserve production structured logger/redaction, do not enable pretty mode, inspect service output for secret equality before rollout, keep IAM access restricted, and never attach raw logs to Jira.
- **Residual risk**: Redis, Meilisearch, MCP, and OpenCode output is not covered by the application logger's redaction.

#### Shared ALB logging exceeds scope

- **Scenario**: Enabling access logs on `they-lb` captures requests for unrelated services.
- **Severity**: High
- **Affected area**: Privacy, cost, and shared infrastructure ownership.
- **Mitigation**: Leave ALB log attributes unchanged and document that collection is ALB-wide.
- **Residual risk**: CRM request-level ALB logs remain unavailable; existing CloudWatch ALB metrics and application logs remain usable.

#### RDS target plan includes unrelated network drift

- **Scenario**: Targeting the whole RDS Terraform resource also changes public accessibility, tags, or other pending settings.
- **Severity**: High
- **Affected area**: Database connectivity and maintenance behavior.
- **Mitigation**: Enable only `postgresql`/`upgrade` through the RDS API when the resource plan is not isolated; read back export state.
- **Residual risk**: Terraform continues to report unrelated RDS drift until separately reconciled.

## Final Compliance Report — 2026-08-14

### AGENTS.md Files Reviewed

- `AGENTS.md` (root and CRM repository instructions supplied by the workspace)
- `.ai/specs/AGENTS.md`
- `.ai/skills/om-spec-writing/SKILL.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
| --- | --- | --- | --- |
| Root AGENTS.md | Keep changes minimal and private to `crm.they.dev` | Compliant | No application module or upstream contribution. |
| Root AGENTS.md | Ask before IAM changes and reject material plan drift | Compliant | Implementation stops at a reviewed live IAM approval gate. |
| Root AGENTS.md | Avoid production EC2 replacement and preserve unrelated state | Compliant | User data untouched; unrestricted apply prohibited. |
| Root AGENTS.md | Verify through real call sites and headed QA | Compliant | Both deploy paths, AWS readbacks, and headed QA are in scope. |
| `.ai/specs/AGENTS.md` | Significant multi-file architecture change requires a spec | Compliant | This spec defines source, runtime, deployment, risks, and rollback. |
| Open Mercato logging docs | Production structured stdout; deployment wires collector | Compliant | Uses current logger output without application changes. |
| Backward compatibility contract | Preserve public contract surfaces | Compliant | No API, event, DI, ACL, schema, module discovery, or UI change. |

### Internal Consistency Check

| Check | Status | Notes |
| --- | --- | --- |
| Data models match API contracts | Pass | Both are N/A. |
| API contracts match UI/UX section | Pass | No API or product UI change. |
| Risks cover all write operations | Pass | IAM, log groups, associations, RDS exports, and container recreation covered. |
| Commands defined for all mutations | N/A | Infrastructure operations, not Open Mercato command contracts. |
| Cache strategy covers all read APIs | N/A | No read API or cache change. |

### Non-Compliant Items

None identified. ALB logs are an explicit, source-backed scope boundary rather than an omitted implementation step.

### Verdict

- **Fully compliant**: Approved for implementation, subject to exact plan review and the live IAM approval gate.

## Changelog

### 2026-08-14

- Added the initial private CRM observability specification after live AWS, Terraform state, Docker runtime, Open Mercato logging documentation, and official AWS/Docker documentation review.
- Recorded existing destructive Terraform drift and made exact targeted operations a hard deployment constraint.

### Review — 2026-08-14

- **Reviewer**: Fresh-context scope-cohesion agent
- **Security**: Passed with the shared-ALB exclusion and live IAM gate
- **Performance**: Passed with an explicit non-blocking buffer and loss tradeoff
- **Cache**: N/A
- **Commands**: N/A
- **Risks**: Passed
- **Scope finding**: The reviewer proposed splitting container, host, SSM, and RDS delivery because they are independently deployable. The original user brief explicitly requires all log categories for one private instance, and THOM-92 records one coordinated operational acceptance/QA boundary, so the finding is resolved in favor of one cohesive rollout.
- **Verdict**: Approved for implementation
