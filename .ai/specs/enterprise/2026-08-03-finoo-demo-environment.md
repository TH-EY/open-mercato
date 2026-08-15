# Finoo Demo Environment

## TLDR

**Key Points:**
- Provision one private, persistent Open Mercato demo for Finoo at `https://finoo.om.they.dev` from the exact `upstream/develop` revision recorded in THOM-83.
- Prove HTTPS reachability and authenticated backend access for isolated superadmin, admin, and employee accounts without exposing their passwords in Git, GitHub Actions, SSM payloads, logs, or persistent container configuration.

**Scope:**
- A first-provision-only GitHub Actions workflow, immutable ECR image, SSM deployment on the existing shared demo host, isolated Compose project/volumes, and an ALB host rule/target group on port `4786`.
- Headed desktop and narrow-viewport login QA, durable Jira evidence, and a mode-`0600`, ignored local credential handoff for Bitwarden import.

**Concerns:**
- Provisioning touches production-scoped AWS credentials, Secrets Manager, a host-role IAM policy, and shared ALB/EC2 infrastructure. These writes require a fresh identity/target read-back and explicit operator approval.
- This specification does not provide lifecycle redeployment. A second explicitly marked first-provision attempt fails closed if any Finoo runtime, target group, listener rule, image tag, worktree, or volume already exists; an ordinary baseline push runs only the unprivileged admission job and skips deployment.

## Overview

Finoo needs a durable customer demo using current Open Mercato behavior, with three role-specific accounts available to the company through Bitwarden. The environment follows the proven private demo topology used by Manoj and preview EPC while narrowing the automation to the requested first provisioning operation.

> **Operational reference**: the existing Manoj lane supplied the OIDC → ECR → SSM → isolated Compose → ALB pattern, host-only Secrets Manager reads, restart policy, and authenticated role smoke. The design rejects Manoj's lifecycle assumptions because Finoo has no pre-existing stack or accounts.

## Problem Statement

There is no Finoo AWS/Docker/ALB/Secrets Manager state. A normal preview is insufficient because the customer environment must persist, have stable credentials, preserve isolated data, and be available under a stable hostname. A generic copy of an existing deploy script would be unsafe because first initialization handles plaintext credentials differently from lifecycle rotation and because the host is shared with other demos.

## Proposed Solution

Create `fork/finoo` from a freshly fetched `upstream/develop` commit and add a branch-bound, first-provision-only workflow requiring the literal, case-sensitive `[finoo:first-provision]` marker in the pushed head commit message. An unprivileged admission job converts that exact match to a boolean before the production environment and OIDC-enabled deployment job can start. The deployment job builds a `linux/amd64` image, pushes a SHA-tagged immutable image to the existing ECR repository, and supplies only secret identifiers plus commit/image provenance to an SSM script.

The host reads three independent passwords directly from Secrets Manager, validates a bounded single-line alphabet, and passes them only as transient bootstrap environment variables. The application initialization output is redacted. After all three authenticated role checks pass, the app container is force-recreated without bootstrap passwords and all checks run again. Only then does the workflow create and verify the Finoo ALB target group and listener rule.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Branch-bound first-provision-only workflow | Makes an explicitly marked initial branch publication executable while an unprivileged exact-case gate keeps ordinary pushes outside the production environment/OIDC job and exact absence preflights protect intentionally marked retries. |
| Exact Finoo resource names and port | Makes collision checks and rollback literal and auditable on the shared host. |
| Secrets Manager values read only on the host | Secret values never enter GitHub expressions, workflow outputs, SSM command parameters, or source control. |
| Temporary bootstrap container configuration | The initializer requires credentials once; recreating the app removes them from running container configuration and removes the bootstrap container/log artifact. |
| Cleanup only newly created Finoo resources on failure | Failed first provision has no customer data yet; exact rollback avoids leaving partial routing, runtime, image, worktree, or volumes. |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| Reuse the Manoj lifecycle updater | It requires an existing stack and exact existing accounts, which Finoo does not have. |
| Perform lifecycle deployment on every `fork/finoo` push | It would silently turn a creation task into ongoing mutation of persistent customer state; this workflow skips ordinary pushes and admits only an explicitly marked first-provision push. |
| Store passwords in GitHub environment secrets or `.env` | It broadens secret exposure and leaves bootstrap credentials in persistent runtime state. |
| Create dedicated DNS/TLS resources | The live wildcard DNS and issued `*.om.they.dev` certificate already cover the hostname; no DNS or certificate change is needed. |

## User Stories / Use Cases

- A company employee wants to open the Finoo URL and sign in as each required role using Bitwarden-managed credentials.
- An operator wants exact proof that the deployment commit, image digest, target health, public login page, and all three authenticated backend sessions match the provisioned environment.
- An operator wants a failed first provision to remove only newly created Finoo state without touching Manoj, EPC, CRM, or baseline resources.

## Architecture

```text
fork/finoo exact commit
  -> explicit `[finoo:first-provision]` branch push (production environment + OIDC)
  -> SHA-tagged linux/amd64 ECR image + digest
  -> SSM on openmercato-upstream-baseline-dokploy
       -> /opt/openmercato-demos/finoo
       -> Compose project demo-finoo
       -> isolated Finoo volumes and port 4786
       -> host-only reads of three Secrets Manager values
       -> pre-scrub and post-scrub role smoke
  -> ALB target group om-demo-finoo
  -> host-header finoo.om.they.dev
  -> headed browser QA and Jira evidence
```

The shared EC2 host, ALB, ECR repository, wildcard DNS, and TLS certificate are reused. The Finoo checkout, Compose project, container names, Docker volumes, runtime secrets, target group, host rule, and external port are isolated and collision-checked.

## Data Models

N/A. This task introduces no Open Mercato entities, database schema, or cross-module relationships. Initialization creates the platform's standard tenant, organization, roles, and users inside Finoo-only PostgreSQL volumes.

## API Contracts

N/A. No application API contract changes. Verification exercises existing contracts:

- `GET /login` for public readiness.
- `POST /api/auth/login` for credential authentication.
- `GET /api/auth/profile` for exact email and expected role proof.
- `GET /backend` for authenticated backend access.

## Internationalization (i18n)

N/A. No user-facing application strings are added. Workflow and operator messages are private infrastructure output.

## UI/UX

No UI implementation changes. QA must prove the existing login and backend at desktop and narrow viewport widths, attach screenshots to THOM-83, and avoid capturing passwords or authentication tokens.

## Configuration

- Hostname: `finoo.om.they.dev`
- Branch: `fork/finoo`
- Compose project: `demo-finoo`
- Deploy environment/image tag: `finoo`
- Host workdir: `/opt/openmercato-demos/finoo`
- Host port: `4786`
- Target group: `om-demo-finoo`
- Secret namespace: `openmercato-upstream-baseline-dokploy/finoo-demo/*`
- Accounts: `superadmin@finoo.om.they.dev`, `admin@finoo.om.they.dev`, `employee@finoo.om.they.dev`

The three password secrets must be independent, 20-96 characters, satisfy upper/lower/digit/special requirements, and use the single-line allowlist `[A-Za-z0-9._!@%+=:-]`.

## Migration & Compatibility

No database migration is authored by this task. The provisioned application runs the migrations already present in the pinned `upstream/develop` commit against new Finoo-only storage. No public contract, upstream branch, existing environment, DNS record, or official-module pointer is modified.

The private branch contains a minimal initializer-output redaction guard required to prevent credential disclosure during first provisioning. All other application behavior remains the pinned upstream baseline.

## Implementation Plan

### Phase 1: Private tracking and immutable baseline
1. Create and read back THOM-83.
2. Fetch `upstream/develop`, create isolated `fork/finoo`, and record the exact SHA.
3. Prove there is no existing Finoo state and that host/port/wildcard DNS/TLS capacity is available.

### Phase 2: Secure first-provision automation
1. Add the branch-bound pinned-action workflow with explicit `[finoo:first-provision]` push opt-in, first-provision script, Compose provisioning overlay, initializer redaction, authenticated smoke, and focused tests.
2. Obtain explicit approval for three Secrets Manager writes, one exact-ARN `GetSecretValue` host-role policy, deployment resources, and exact failed-provision rollback.
3. Generate independent passwords locally, create the secrets, read back metadata/policy, commit with `[finoo:first-provision]` in the message, and push `fork/finoo` to start the first-provision workflow.

### Phase 3: Verification and handoff
1. Read back GitHub run, ECR digest, remote commit/image, container health/restart policy, empty bootstrap credential configuration, target health, HTTPS, and three role smokes.
2. Run headed desktop and narrow browser login/backend QA without capturing secret fields; attach evidence to THOM-83.
3. Obtain independent release-evidence review, then create the ignored mode-`0600` credential file, verify it is excluded from Git, and open it in Cursor.

### File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `.github/workflows/fork-finoo-demo-provision.yml` | Create | Branch-bound immutable image build and first provision restricted to explicitly marked head commits. |
| `infra/aws-upstream-baseline/finoo-demo-provision.sh` | Create | Collision checks, host provisioning, role proof, ALB routing, and exact rollback. |
| `infra/aws-upstream-baseline/docker-compose.finoo-provision.yml` | Create | Restart policy and transient bootstrap credential mapping. |
| `scripts/smoke-auth-dashboard.mjs` | Create | Auth/profile/role/backend verifier. |
| `scripts/__tests__/finoo-deployment-security.test.mjs` | Create | Deployment security and smoke regression tests. |
| `packages/cli/src/mercato.ts` | Modify | Redact initializer credential output when explicitly requested by the operator. |

### Testing Strategy

- Bash and Node syntax checks.
- Focused Node tests for workflow binding, immutable action refs, secret-ID-only transport, first-provision collision gates, single-line secret policy, exact rollback, bootstrap scrubbing, and role mismatch rejection.
- YAML parsing and merged Compose configuration validation.
- Gitleaks scan restricted to the new/changed Finoo artifacts.
- Live AWS/GitHub/SSM/ALB read-backs plus public and authenticated smoke.
- Headed browser QA for all roles, with desktop and narrow screenshots attached to Jira.

## Risks & Impact Review

### Data Integrity Failures

No existing Finoo data may be mutated: every pre-existing Finoo artifact causes a hard failure before provisioning. If first provisioning fails, the workflow removes only the new `demo-finoo` containers/volumes, image tag, worktree, listener rule, and target group. No generic cleanup or shared volume operation is permitted.

### Cascading Failures & Side Effects

The shared host and ALB are common dependencies. Repository-local concurrency serializes known demo deploys, while fresh port, hostname, rule, workdir, image-tag, project, and volume checks fail closed on external races. Existing demos are never deregistered or modified.

### Tenant & Data Isolation Risks

Finoo uses a dedicated PostgreSQL volume and standard first initialization, so all three accounts are created in one new tenant. The public host-header routes only to port `4786`. The browser proof must verify exact emails and roles; no customer data is used.

### Migration & Deployment Risks

The exact Git commit and ECR digest are checked before routing. The target group and public rule are created only after two complete sets of authenticated role smokes, including one after removing bootstrap credentials from the app container. A future update is intentionally out of scope: ordinary branch pushes run only the unprivileged admission job and skip the credential-bearing first-provision job, while an explicit, case-sensitive `[finoo:first-provision]` push still fails closed during exact first-provision admission before image mutation.

### Operational Risks

Host disk is already materially used. The new image and isolated volumes increase usage; this task performs no shared Docker pruning. GitHub run output, SSM status, target health, HTTPS, and screenshots provide detection. Residual risk is one additional persistent demo sharing host CPU, memory, disk, ALB, and ECR with existing demos.

### Risk Register

#### Secret disclosure during initialization
- **Scenario**: Passwords are printed by the initializer or remain in `.env`, Docker metadata, logs, Actions, or SSM payloads.
- **Severity**: Critical
- **Affected area**: Finoo role accounts and shared deployment evidence.
- **Mitigation**: Host-only secret reads, strict single-line policy, no password values in `.env`/Actions/SSM parameters, redacted initializer output, stdin smoke transport, app recreation, container-env inspection, and targeted secret scanning.
- **Residual risk**: A host administrator can observe transient process/container memory during bootstrap; this is within the existing trusted deployment-host boundary.

#### Partial first provisioning
- **Scenario**: Build, initialization, smoke, target registration, or HTTPS verification fails after some Finoo resources are created.
- **Severity**: High
- **Affected area**: New Finoo-only runtime and routing resources.
- **Mitigation**: Fresh absence preflight, EXIT cleanup, SSM cancellation on timeout, exact new-resource flags, and deletion limited to literal Finoo project/path/rule/target resources.
- **Residual risk**: Provider-side deletion can fail; the workflow reports failure and requires read-only reconciliation before any retry.

#### Shared-host resource pressure
- **Scenario**: The new stack exhausts disk, memory, CPU, or container-port capacity and degrades other demos.
- **Severity**: High
- **Affected area**: Shared EC2 demo host.
- **Mitigation**: Fresh host capacity/port/container inventory, no duplicate Finoo artifacts, serialized deploy, and post-deploy health read-back.
- **Residual risk**: Workload growth after handoff is not automatically capacity-limited; follow-up monitoring remains an operations responsibility.

#### Production OIDC/action supply-chain compromise
- **Scenario**: Mutable third-party Actions code executes with the deployment role.
- **Severity**: High
- **Affected area**: ECR, SSM host, ALB, and permitted AWS resources.
- **Mitigation**: Full commit-SHA pins for every Action, GitHub production environment, repository/ref-scoped AWS trust, minimal job permissions, and exact-resource deployment checks.
- **Residual risk**: A compromised pinned Action commit or repository write authority remains within the existing CI trust boundary.

## Final Compliance Report — 2026-08-03

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)
- `.ai/specs/AGENTS.md`
- `.ai/skills/om-spec-writing/SKILL.md`
- Open Mercato Jira/environment workflow skills under `/Users/patrykmadaj/.agents/skills/`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root `AGENTS.md` | Use the smallest complete change and preserve unrelated work | Compliant | Isolated worktree; first provision only; no changes to existing demos. |
| root `AGENTS.md` | Fresh identity, target, immutable artifact, and diff before shared writes | Compliant | Explicit gates in phases and acceptance evidence. |
| root `AGENTS.md` | Ask before IAM, credentials, secrets, or destructive environment changes | Compliant | Required approval is an explicit Phase 2 hard stop; rollback is enumerated. |
| root `AGENTS.md` | Never commit credentials or local-only ops files | Compliant | Secret values remain in Secrets Manager and an ignored mode-`0600` handoff. |
| root `AGENTS.md` | Pin exact resource scope and protect other environments | Compliant | Literal Finoo names/path/port and fail-closed collision checks. |
| `.ai/specs/AGENTS.md` | Enterprise specs stay in enterprise scope and avoid secrets | Compliant | Private environment spec under `.ai/specs/enterprise/`; identifiers only. |
| application module rules | Data/API/UI/optimistic locking/i18n | N/A | No application entity, API, form, or user-facing string changes. |
| backward compatibility contract | Do not break public contract surfaces | Compliant | One additive private environment guard; no removed or changed public contract. |

### Internal Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | Both are N/A; existing auth APIs are only exercised. |
| API contracts match UI/UX section | Pass | Existing login/profile/backend paths are used consistently for QA. |
| Risks cover all write operations | Pass | Secrets, IAM, ECR, SSM/runtime, ALB, Jira evidence, and local handoff are covered. |
| Commands defined for all mutations | Pass | Mutations are workflow/AWS operations, not application commands; exact rollback is specified. |
| Cache strategy covers all read APIs | Pass | N/A; no new read API or cache surface. |

### Non-Compliant Items

None.

### Verdict

- **Fully compliant**: Approved — ready for implementation after the explicit IAM/secrets/deployment approval gate.

## Changelog

### 2026-08-15
- Required an unprivileged, exact-case `[finoo:first-provision]` push gate so ordinary private baseline updates skip the production/OIDC first-provision job instead of reporting the expected existing-resource denial as a failed build.

### 2026-08-03
- Initial specification based on THOM-83, fresh `upstream/develop`, live read-only infrastructure inventory, Manoj/EPC deployment patterns, deep review, and security review.

### Review — 2026-08-03
- **Reviewer**: Root agent plus independent deep and security reviewers
- **Security**: Passed after narrowing to first provision, eliminating persistent bootstrap passwords, adding exact rollback, safe secret alphabet, temporary Docker auth, and immutable Action refs
- **Performance**: Passed with residual shared-host capacity risk recorded
- **Cache**: N/A
- **Commands**: Passed; no application command surface added
- **Risks**: Passed; IAM/secrets/deployment remain approval-gated
- **Verdict**: Approved pending operator approval for live writes
