# crm.they.dev MCP Ingress Terraform Ownership

## TLDR

Adopt the already-live MCP target group and `/mcp` listener rule into Terraform,
declare the existing ALB-only port `3002` security-group ingress, and preserve the
application fallback at priority `1003`. Keep the registered EC2 target attachment as
a documented exception because the provider resource does not support import.

## Overview

The public Open Mercato MCP endpoint runs at `https://crm.they.dev/mcp`. AWS
already routes this path to a dedicated instance target group on port `3002`, but
the target group, listener rule, and security-group ingress were not represented
in the CRM Terraform environment.

## Problem Statement

Manual ingress resources can regress when listener priorities or ports change.
Leaving all MCP routing outside Terraform also makes future plans incomplete. A
direct declaration of the live target attachment is not safe because
`aws_lb_target_group_attachment` does not support import and a create plan pulls in
unrelated EC2 AMI drift. A future provider upgrade must not be assumed to add import.

## Proposed Solution

- Declare and import the existing MCP target group on port `3002`.
- Declare and import the host-and-path listener rule at priority `1002`.
- Declare the matching app security-group ingress from the ALB security group only.
- Change the application host fallback declaration from priority `1002` to its
  already-live priority `1003`.
- Keep the API key out of Terraform state and repository files.
- Preserve the already-live EC2 target attachment as a documented exception;
  recreating the attachment is outside this change.
- Block any future EC2-replacing apply until that change includes a reviewed
  register-new, wait-healthy, verify, and deregister-old MCP target procedure.

## Architecture

`crm.they.dev` HTTPS traffic reaches the shared `they-lb` listener. Requests whose
host is `crm.they.dev` and path is `/mcp` match priority `1002` and forward to
`om-crm-mcp-they-tg` on instance port `3002`. Other traffic for the host matches
priority `1003` and forwards to the application target group on port `3001`.
The application security group permits both ports only from the ALB security group.

## Data Models

No application data model, database schema, secret value, tenant record, or MCP API
key is stored or changed by this Terraform declaration.

## API Contracts

- `GET /login` remains routed to the application and returns a successful response.
- Unauthenticated `POST /mcp` remains public at the network layer but returns `401`.
- Authenticated MCP JSON-RPC requests continue to use the `x-api-key` header.
- No Open Mercato application API route or response schema changes.

## Migration

1. Import the existing MCP target group and listener rule into their exact module addresses.
2. Refresh the existing application listener rule and app security group into state.
3. Review a saved targeted plan covering only the MCP resources, existing app
   listener rule, and app security group.
4. Apply only when the plan contains no resource replacement or deletion and no unrelated drift.
5. Verify the existing `i-0f2bf77841475e173:3002` attachment directly in AWS and,
   while the scheduled instance is running, require it to become `healthy`.
6. Do not run a future plan that replaces `module.crm.aws_instance.app` until the
   same change registers the new instance on port `3002`, waits for `healthy`,
   verifies `/mcp`, and only then deregisters the old target. Terraform state owns
   the target group and listener rule, not the target registration.

## Verification

- `tofu fmt -check -recursive infra/terraform`
- `tofu validate` in `infra/terraform/environments/crm-they-dev`
- `node --test scripts/__tests__/crm-observability.test.mjs`
- Post-apply targeted plan reports no changes.
- While the scheduled instance is running, both target groups are healthy;
  `/login` returns `200`, unauthenticated `/mcp` returns `401`, and an
  authenticated MCP call succeeds. A stopped instance is expected to report an
  unusable target and is not valid pre-apply health evidence.

## Risks & Impact Review

| Failure scenario | Severity | Affected area | Mitigation | Residual risk |
| --- | --- | --- | --- | --- |
| Listener priority routes `/mcp` to the app target | High | Public MCP availability | Explicit host-and-path rule at `1002`; app fallback at `1003`; direct AWS read-back | Low |
| Port `3002` becomes publicly reachable outside the ALB | High | Network exposure | Security-group source is the ALB security group, not a CIDR | Low |
| Terraform replaces EC2 because of AMI drift | High | CRM availability | Do not declare the unimportable attachment; use a saved targeted plan with zero replacements | Low |
| Existing target attachment drifts because it remains unmanaged | Medium | MCP availability | Document the exception, block EC2-replacing applies without a re-registration runbook, and verify target health | Medium until a supported adoption or automated replacement path exists |
| API key leaks into state or Git | High | MCP authorization | No secret variables or literal headers in Terraform | Low |
| Invalid-key floods exhaust MCP or database capacity | High | Shared CRM and MCP availability | Require a separately reviewed pre-authentication limiter or path-scoped WAF rule before claiming DoS hardening | Medium; no WAF or pre-authentication limiter exists today |

## Rollback

If import or planning reveals material drift, stop without applying. If an in-place
apply fails, restore listener priorities `1002` for `/mcp` and `1003` for the app,
retain the existing target group and attachment, and verify public routing again.
For a future EC2 replacement, retain or re-register the old MCP target until the new
target is healthy and authenticated and unauthenticated probes pass.

## Final Compliance Report

- Scope is limited to CRM ingress ownership and documentation.
- No EC2, RDS, DNS, TLS, IAM, schedule, database, or secret resource is changed.
- The non-importable attachment, future EC2 replacement block, and manual
  registration state boundary are explicit.
- Verification requirements cover Terraform syntax, repository tests, AWS target
  health, listener routing, unauthenticated rejection, and authenticated MCP access.
- Public pre-authentication rate limiting remains a documented residual risk and
  is not represented as solved by this infrastructure adoption.

## Changelog

- 2026-08-14: Added the implemented MCP ingress ownership, migration boundary,
  verification evidence, risks, and rollback requirements.
