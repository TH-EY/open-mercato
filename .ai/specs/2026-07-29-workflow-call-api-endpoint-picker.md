# Workflow Call API Endpoint Picker

## TLDR

Add an authenticated workflow endpoint catalog and a structured picker for `CALL_API` activities. Authors can discover internal API routes, fill required and optional parameters, inspect declared request and response schemas, and catch incomplete required parameters before saving while retaining the existing free-text configuration path.

**Scope:**

- Read-only `GET /api/workflows/endpoints` catalog derived from the registered OpenAPI surface.
- `CALL_API` editor picker with method/path search, typed parameter rows, schema hints, and validation.
- Backward-compatible round-trip for existing manual `CALL_API` configurations.
- Unit, API-route, and headed UI coverage for the changed paths.

**Non-goals:**

- Changing `CALL_API` runtime execution, SSRF controls, role resolution, or target-endpoint authorization semantics.
- Requiring all routes to declare schemas.
- Replacing the advanced/manual JSON editor for existing activity configuration.
- Adding a second HTTP activity type or a persisted endpoint registry.

## Overview

The workflows editor currently requires authors to enter `CALL_API` configuration as raw JSON. This feature introduces a discoverable, structured authoring surface over the existing configuration contract without changing execution behavior.

The closest market reference is n8n's [HTTP Request node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/): it separates method, URL, query parameters, headers, and body while preserving raw configuration options. Open Mercato adopts that structured-first/manual-fallback pattern, but uses its own registered OpenAPI surface rather than an external API import.

## Problem Statement

Workflow authors must already know internal paths, methods, parameter names, and response shapes. The editor cannot distinguish required from optional inputs, unresolved required values can reach runtime, and declared OpenAPI request/response schemas are not available at the point of configuration.

## Proposed Solution

1. Project the registered OpenAPI document into a minimal workflow endpoint catalog.
2. Expose the projection through an authenticated, feature-gated read API.
3. Add one reusable `CALL_API` configuration editor to every existing workflow activity authoring surface.
4. Keep `config.endpoint`, `config.method`, `config.headers`, and `config.body` as the persisted contract.
5. Preserve raw JSON editing as an advanced fallback and preserve unknown/manual endpoints.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Build from registered route manifests | Keeps the picker aligned with the same source used by generated OpenAPI documentation. |
| Cache per server process | The enabled route surface is structural and changes only on deploy/restart; rebuilding it on every keystroke would be wasteful. |
| Omit undeclared response schemas | An honest “not declared” state is safer than presenting the generator's generic object fallback as a real contract. |
| Preserve free-text endpoint editing | Existing workflows and custom internal endpoints must continue to round-trip without catalog coupling. |
| Validate only catalog selections | The picker can prove required parameters only for a matched declared operation; manual endpoints retain existing behavior. |
| Do not filter the catalog by each target route's ACL | This change is an authoring metadata view guarded by workflow-definition access. Runtime authorization remains authoritative; per-operation visibility would be a separate security/architecture capability. |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| Persist endpoint metadata in a database | Duplicates generated structural metadata and introduces synchronization/migration work. |
| Call the public docs route from the server | Adds an avoidable HTTP hop and risks configuration/auth drift from the in-process registry. |
| Replace `CALL_API` config with a new normalized model | Breaks the stable workflow definition contract and existing definitions. |
| Block endpoints absent from the catalog | OpenAPI coverage is additive and incomplete; the fallback is required for compatibility. |

## User Stories / Use Cases

- A workflow author wants to search internal API operations by path, summary, method, or tag so that they do not need to memorize route names.
- A workflow author wants required and optional parameters separated and typed so that incomplete operations are caught while editing.
- A workflow author wants declared request and response fields visible so that the activity body and downstream expectations can be configured deliberately.
- An existing workflow owner wants a manually authored `CALL_API` configuration to save, reload, and edit unchanged.

## Architecture

```text
registered modules + API manifests
              |
              v
attachOpenApiDocsToModules(route manifests, registered module APIs)
              |
              v
process-cached endpoint projection
              |
              v
GET /api/workflows/endpoints
              |
              v
CALL_API endpoint picker -> existing activity.config
```

`endpoint-catalog.ts` is server-only and projects path, method, summary, first tag, supported parameter locations, and declared JSON request/response schemas. Pure `endpoint-path.ts` helpers match a configured endpoint to a route template and compose path/query values without encoding workflow interpolation tokens.

The catalog API performs the normal request-container, authentication, organization-scope, and `workflows.definitions.view` checks before returning structural metadata. Catalog visibility does not grant permission to call an operation. At runtime, the unchanged `CALL_API` executor continues to apply the initiating actor's roles and the existing `/api/*`/same-host SSRF rules.

The picker uses `apiCall`, loads lazily, and degrades to the manual input when the request fails or a route is not declared. Selecting a declared operation inserts namespaced generated placeholders for required parameters. Only those generated placeholders participate in host editor validation, so blank, unknown, and manually braced legacy endpoints retain their existing behavior. Optional fields remain unset unless the author provides a value; empty optional path segments are omitted. Literal path/query values are URI-encoded while workflow interpolation tokens remain intact.

### Frontend Architecture Contract

#### Server/Client Boundary Map

| Surface | Server root | Client islands | Data owner | Notes |
|---------|-------------|----------------|------------|-------|
| Existing workflow definition editors | Unchanged existing routes | Existing node/edge dialogs, `TransitionsEditor`, plus `EndpointPicker` | `/api/workflows/endpoints` | Create/edit pages keep their existing page/layout roots. |

#### `"use client"` Ledger

| File | Reason | Imported by | Heavy deps? | Cleanup / hydration risk | Alternative rejected |
|------|--------|-------------|-------------|--------------------------|----------------------|
| `components/fields/EndpointPicker.tsx` | Search/popover state, lazy API loading, parameter editing | Existing activity editors | No; existing UI primitives only | Abort-safe React state; no global listeners/providers | Server rendering cannot provide interactive editing. |
| `components/fields/EndpointPickerParts.tsx` | Small client-rendered helpers and schema-hint presentation shared with the picker | `EndpointPicker.tsx` and existing activity editors | No; existing UI primitives only | Stateless; no effects or global state | Keeping the main picker under the client-file size budget avoids a single oversized island. |

#### Client Blob Guardrail and Budgets

| Budget | Target |
|--------|--------|
| New client page roots | 0 |
| New client files over 300 LOC | 0; pure matching/schema helpers stay outside the component |
| New heavy browser libraries | 0 |
| Hydration/interactivity evidence | Component tests plus headed save/reload/edit flow |
| Static boundary evidence | `corepack yarn check:client-boundaries` if available, otherwise targeted typecheck/build |
| Runtime signal | Headed route load at desktop and narrow viewport; no new provider/bootstrap |

### Commands, Events, Cache, and Side Effects

- No commands, mutations, events, subscribers, jobs, or database writes are added.
- The process cache contains structural, non-tenant endpoint metadata only.
- Cache reset is exported only for deterministic tests; normal refresh occurs on application restart/deploy.

## Data Models

No persisted entities or database migrations are introduced.

The API projection uses these transient shapes:

```ts
type WorkflowEndpointParam = {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  type: string
}

type WorkflowEndpointDescriptor = {
  path: string
  method: string
  summary: string
  tag: string
  params: WorkflowEndpointParam[]
  hasRequestSchema: boolean
  requestSchema?: Record<string, unknown>
  responseSchema?: Record<string, unknown>
}
```

No PII, credentials, request bodies, tenant records, or execution data enter the catalog.

## API Contracts

### List Workflow Endpoint Catalog

- `GET /api/workflows/endpoints`
- Auth: required.
- Feature: `workflows.definitions.view`.
- Request body: none.
- Response:

```json
{
  "items": [
    {
      "path": "/api/customers/people/{id}",
      "method": "GET",
      "summary": "Get a customer person",
      "tag": "Customers",
      "params": [
        { "name": "id", "in": "path", "required": true, "type": "string" }
      ],
      "hasRequestSchema": false,
      "responseSchema": { "type": "object", "properties": {} }
    }
  ]
}
```

- Errors: `400` missing tenant context, `401` unauthenticated, `403` missing workflow-definition view access, `500` catalog assembly failure.
- OpenAPI: the route exports `metadata` and `openApi`; the response is backed by a Zod schema.
- Pagination: not applicable. The result is a finite structural route registry assembled once per process.

### Existing `CALL_API` Contract

No fields are removed, renamed, or retyped. The picker continues to write the established structure:

```json
{
  "endpoint": "/api/customers/people/{{context.personId}}?include=details",
  "method": "GET",
  "headers": {},
  "body": {}
}
```

## Internationalization

All picker labels, empty/loading/failure states, parameter validation, request schema, response schema, and manual-fallback copy use `workflows.endpointPicker.*` keys in `en`, `de`, `es`, and `pl`.

## UI/UX

- The endpoint remains a visible labeled text input.
- “Browse endpoints” opens a searchable popover grouped by OpenAPI tag.
- Each result shows method, path, and summary.
- Selecting a result writes method and path, then renders required parameters before optional parameters.
- Parameter rows show location and primitive type. Required empty values use `aria-invalid` and semantic error text.
- Declared request and response schemas render compact top-level field hints. Missing schemas render honest localized copy.
- Manual endpoints and raw JSON remain available.
- Catalog loading failure is non-destructive and does not clear the current endpoint.
- Existing dialogs retain `Cmd/Ctrl+Enter` submit and `Escape` cancel.

## Migration & Backward Compatibility

- No data migration or backfill.
- `CALL_API` runtime behavior is unchanged.
- Existing definition JSON round-trips unchanged.
- The new GET route and response fields are additive contract surfaces.
- The manual configuration path remains supported for at least the existing compatibility horizon.
- Required-parameter validation recognizes only namespaced placeholders generated by the picker; unknown manual endpoints, including manually authored braces, are not rejected.

## Implementation Plan

### Phase 1: Catalog and Pure Helpers

1. Add pure endpoint matching/composition and schema-hint helpers with unit tests.
2. Add the server-only OpenAPI projection and deterministic cache reset.
3. Add Zod/OpenAPI response schemas and the guarded GET route with authorization and error tests.

### Phase 2: Structured Authoring

1. Add the reusable picker with loading, search, selection, schema hints, and inline validation.
2. Integrate it into all current node/transition activity editors, including the create/edit-page `TransitionsEditor`, without removing raw JSON.
3. Add locale keys and component/editor tests, including manual config round-trip.

### Phase 3: Integration Evidence

1. Add a self-contained Playwright scenario for browse → select → required validation → save → reload → edit.
2. Run targeted unit/API/UI tests, typecheck/build checks, and DS/client-boundary checks.
3. Deploy the exact branch candidate and complete headed desktop/narrow-viewport QA with durable evidence.

### File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/modules/workflows/lib/endpoint-path.ts` | Create | Pure matching, composition, and validation helpers. |
| `packages/core/src/modules/workflows/lib/endpoint-schema.ts` | Create | Shared safe record/schema-hint projection helpers. |
| `packages/core/src/modules/workflows/lib/endpoint-catalog.ts` | Create | Server-side OpenAPI projection/cache. |
| `packages/core/src/modules/workflows/lib/call-api-editor-validation.ts` | Create | Shared unresolved-placeholder validation for classic and CrudForm hosts. |
| `packages/core/src/modules/workflows/api/endpoints/route.ts` | Create | Authenticated endpoint catalog API. |
| `packages/core/src/modules/workflows/api/openapi.ts` | Modify | Zod schemas for the additive response contract. |
| `packages/core/src/modules/workflows/components/fields/EndpointPicker.tsx` | Create | Structured interactive picker. |
| `packages/core/src/modules/workflows/components/fields/EndpointPickerParts.tsx` | Create | Bounded presentation/helpers split from the interactive picker. |
| Existing node/edge activity editors and `TransitionsEditor.tsx` | Modify | Reuse picker for `CALL_API`; retain raw JSON fallback. |
| `packages/core/src/modules/workflows/components/formConfig.tsx` | Modify | Apply translated generated-placeholder validation to definition transitions. |
| Definition create/edit pages | Modify | Use the translated workflow-definition form schema. |
| `packages/core/src/modules/workflows/i18n/*.json` | Modify | Localized user-facing copy. |
| Module-local tests and `__integration__` | Create/modify | Pure, API, component, and Playwright coverage. |

## Testing Strategy

### Unit and Component

- Template matching handles exact paths, path placeholders, optional path omission, workflow interpolation tokens, URI-reserved values, query values, trailing slashes, method mismatches, and deterministic ambiguous matches.
- Catalog projection includes supported methods/parameters/schemas, sorts deterministically, and omits undeclared response placeholders.
- Picker search, selection, required/optional ordering, request/response hints, lookup failure, and manual fallback.
- Classic and CrudForm editor hosts retain manual configs and surface required parameter errors before submission.

### API

- Authenticated and authorized request returns projected items.
- Unauthenticated, missing tenant context, and missing feature paths return `401`, `400`, and `403`.
- Assembly failure returns a minimal `500`.
- Generated OpenAPI includes the declared catalog response shape.

### Integration / Headed QA

- Create all workflow fixtures in the test; do not rely on demo data.
- Open a definition editor, add/select `CALL_API`, browse and pick a real declared endpoint.
- Confirm a required parameter blocks/surfaces submission until populated.
- Confirm optional parameters may remain empty.
- Confirm declared request and response hints are visible.
- Save, reload, edit, and verify the same endpoint/method/parameters round-trip.
- Repeat the critical interaction at desktop and narrow viewport.
- Clean up the definition in `finally`.

## Risks & Impact Review

### Endpoint Metadata Exposure

- **Scenario**: A user with workflow-definition view access sees route names or schema fields for operations they cannot execute.
- **Severity**: Medium
- **Affected area**: `GET /api/workflows/endpoints`, workflow authoring UI
- **Mitigation**: Require authenticated tenant context and the existing workflow-definition feature; return structural schemas only, never data, credentials, or examples. Keep runtime target authorization unchanged and explicit in UI/docs.
- **Residual risk**: Route names remain visible to workflow authors. Per-route catalog filtering is deferred as a separate authorization capability because current route metadata does not expose a uniform feature map.

### Stale Process Catalog

- **Scenario**: A dynamically changed module surface is not reflected until process restart.
- **Severity**: Low
- **Affected area**: Picker results
- **Mitigation**: The catalog is built from structural module registration, which already requires generation/restart/deploy; tests can clear the cache.
- **Residual risk**: During local hot development a restart may be required, matching other generated structural registries.

### Incomplete OpenAPI Declarations

- **Scenario**: An operation appears without useful request or response schema information.
- **Severity**: Medium
- **Affected area**: Schema hints
- **Mitigation**: Render an honest “not declared” state and retain manual configuration. Do not infer contracts from generic object fallbacks.
- **Residual risk**: Authoring quality depends on route owners declaring accurate schemas.

### Catalog Load Failure

- **Scenario**: Catalog assembly or the client request fails.
- **Severity**: Low
- **Affected area**: Structured picker only
- **Mitigation**: Preserve the current config, show localized fallback copy, and keep manual editing available.
- **Residual risk**: Authors temporarily lose discoverability but not the ability to edit or run existing workflows.

### Existing Configuration Regression

- **Scenario**: A manually authored endpoint is reformatted, rejected, or loses unknown config fields.
- **Severity**: High
- **Affected area**: Workflow definitions and runtime behavior
- **Mitigation**: Write only known endpoint/method changes, preserve the raw JSON editor and unknown keys, validate required parameters only for matched catalog operations, and add save/reload/edit regression coverage.
- **Residual risk**: A manual value that intentionally resembles an unresolved route template may be presented as incomplete; the author can switch to a concrete/interpolated value.

### Large Catalog UI Cost

- **Scenario**: Hundreds of routes make the popover slow or hard to scan.
- **Severity**: Low
- **Affected area**: Client interaction
- **Mitigation**: Lazy load, in-memory text filtering, bounded scroll region, grouped results, and no heavyweight combobox dependency.
- **Residual risk**: Very large installations may later need server-side search/virtualization; no evidence currently justifies that complexity.

## Final Compliance Report — 2026-07-29

### AGENTS.md Files Reviewed

- `AGENTS.md`
- `BACKWARD_COMPATIBILITY.md`
- `.ai/specs/AGENTS.md`
- `.ai/qa/AGENTS.md`
- `.ai/ds-rules.md`
- `packages/core/AGENTS.md`
- `packages/core/src/modules/workflows/AGENTS.md`
- `packages/ui/AGENTS.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| Root / workflows AGENTS | Preserve tenant scope and SSRF/runtime behavior | Compliant | Route checks scoped workflow permission; executor is unchanged. |
| Root / core AGENTS | API routes export `metadata` and `openApi` | Compliant | New GET contract declares both. |
| Root AGENTS | Use `apiCall`, not raw `fetch` | Compliant | Picker uses the shared client helper. |
| Backward compatibility | Existing API/definition contracts remain stable | Compliant | Additive route; existing config shape/manual path retained. |
| UI / DS rules | Semantic tokens, shared primitives, labels, accessible validation | Compliant | Existing primitives and semantic error states only; no raw controls or hardcoded colors added. |
| QA rules | Feature includes self-contained API and key UI integration coverage | Compliant | Fixtures/cleanup and required flow are specified. |
| Optimistic locking | New editable entity writes carry versions | N/A | No entity or write endpoint is added. |
| Encryption / tenancy data | Sensitive persisted data uses encryption/scoping | N/A | No persistence or business data access. |
| Commands/events | Mutations use canonical commands/events | N/A | The feature is read-only metadata plus client editing of the existing definition payload. |

### Internal Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | Transient descriptor shape matches the GET response. |
| API contracts match UI/UX section | Pass | Every rendered hint comes from the declared projection. |
| Risks cover all operations | Pass | Read/API, cache, failure, compatibility, and scale paths are covered. |
| Commands defined for all mutations | Pass | No new mutation exists. |
| Cache strategy covers read APIs | Pass | Structural process cache and refresh behavior are explicit. |
| Frontend boundaries and budgets | Pass | One bounded client island; no page/provider changes or heavy dependency. |

### Non-Compliant Items

None identified.

### Verdict

**Fully compliant: Approved — ready for implementation.**

## Changelog

### 2026-07-29

- Added the initial scope skeleton for public issue #4235.
- Expanded the approved scope with architecture, API/UI contracts, compatibility, tests, risks, and frontend boundaries.
- Scope-cohesion review: KEEP. The catalog, picker, validation, and compatibility path are one independently deployable authoring capability.
- Reviewed current n8n structured HTTP-request authoring as the market reference; retained Open Mercato's manual fallback and internal OpenAPI source.
- Recorded the implemented compatibility boundary: declared selections use unresolved placeholders as the save guard, while blank and unknown legacy endpoints retain their existing behavior.
- Split stateless picker presentation helpers into `EndpointPickerParts.tsx` to keep the interactive client island below the 300-line budget.
- Closed primary-review gaps by integrating the normal create/edit `TransitionsEditor`, namespacing generated required placeholders, omitting empty optional path segments, clearing stale generated headers, and URI-encoding literal parameter values.
- Added host-level validation coverage for visual and CrudForm node/edge editors plus definition-transition form coverage; the required Playwright lifecycle remains a Phase 3 deployment task.
- **Reviewer**: Agent plus fresh-context scope review
- **Security**: Passed with route-metadata exposure recorded as a residual risk
- **Performance**: Passed with lazy load and bounded client scope
- **Cache**: Passed with process-local structural cache
- **Commands**: N/A; no mutation introduced
- **Risks**: Passed
- **Verdict**: Approved
