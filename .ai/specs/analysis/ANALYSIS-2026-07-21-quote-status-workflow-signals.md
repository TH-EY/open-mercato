# Pre-Implementation Analysis: Quote Status Workflow Signals

## Executive Summary

The corrected specification is ready for implementation. The design is additive, uses the existing event catalog and correlated-wait runtime, and now covers every actual forward Quote status mutation plus every graph-restoring undo without treating record recreation as a status transition.

## Backward Compatibility

### Violations Found

None.

| # | Surface | Assessment | Severity | Required implementation guard |
|---|---|---|---|---|
| 1 | Auto-discovery | Existing `sales/events.ts` is extended; no convention changes. | None | Run generation, never edit generated files manually. |
| 2 | Type definitions | No existing public type is narrowed; `transition.condition` is additively preserved using the existing expression contract. | None | Reuse the Business Rules safety validator. |
| 3 | Function signatures | Existing public signatures remain unchanged. | None | Do not export or alter shared APIs. |
| 4 | Import paths | No file move or import-path removal. | None | Use existing package exports. |
| 5 | Event IDs | One additive event ID; existing IDs/payloads unchanged. | None | Treat the new ID as frozen after delivery. |
| 6 | Widget spots | No spot change. | None | N/A. |
| 7 | API routes | No route, method, authorization, or response change. The definition request additively preserves optional inline conditions already supported by runtime. | None | Reuse `/api/events` and the existing condition expression. |
| 8 | Database schema | No schema change. | None | N/A. |
| 9 | DI names | Existing `eventBus` resolution only. | None | Do not add/rename registrations. |
| 10 | ACL feature IDs | No ACL change. | None | Preserve current guards. |
| 11 | Notification IDs | No notification change. | None | N/A. |
| 12 | CLI commands | No CLI change. | None | N/A. |
| 13 | Generated contracts | Registry contents grow additively. | None | Verify generated diff is scoped. |

### Missing BC Section

None. The specification contains an explicit migration and backward compatibility section.

## Spec Completeness

### Missing Sections

None. Data Models and API Contracts explicitly record that no changes are required.

### Incomplete Sections

None after the undo-policy correction.

## AGENTS.md Compliance

### Violations

None identified.

| Rule | Location | Resolution |
|---|---|---|
| Cross-module side effects use events | Architecture | Sales owns the event; Workflows remains a generic subscriber. |
| Side effects occur after commit | Status mutation coverage | Forward paths emit only after their successful write boundary. |
| Event scope uses trusted metadata | Event contract | Tenant and organization come from persisted Quote state and event options. |
| Reuse existing UI primitives | Signal catalog UI | Reuses `EventPatternInput`; no raw fetch or new primitive. |
| Preserve custom values | Signal catalog UI | `allowCustomValues` remains enabled. |
| High-risk workflow behavior has integration coverage | Integration coverage | `TC-WF-034` specifies wrong-Quote, wrong-status, target-status, and duplicate cases. |

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Domain/event producer dual write | A committed status may lack an event if enqueue fails. | Surface enqueue error; emit immediately after write; document transactional-outbox follow-up for upstream hardening. |
| Cross-tenant/wrong-Quote delivery | Wrong workflow could advance. | Trusted scope options plus exact Quote-ID correlation and locked re-check. |
| Non-target status consumes wait | Workflow advances too early. | Existing condition-first correlated handler is verified by `correlated-signal-handler.test.ts` and keeps the wait active. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Incomplete undo coverage | Restored status could be invisible to workflows. | One shared restore-and-emit wrapper covers all seven graph-restoring undo call sites and ignores recreation. |
| Feature-flagged editor drifts | One editor still shows a plain input. | Modify and directly test both dialog implementations. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Ordinary Quote edits create queue noise | Unnecessary events. | Compare stored status values and emit only on actual change. |

## Gap Analysis

### Critical Gaps (Block Implementation)

None. The graph-restoring undo policy was added to the specification before coding.

### Important Gaps (Should Address)

- Producer atomicity: retain as an explicit residual risk and upstream platform follow-up; do not hide enqueue failures.

### Nice-to-Have Gaps

- A future status-value picker may discover dictionary values, but it is not required for this event/correlation slice.

## Remediation Plan

### Before Implementation (Must Do)

1. Correct undo coverage in the specification — completed.
2. Verify condition-first wait behavior in actual tests — completed; rejected candidates remain active/paused.
3. Verify saved definitions preserve inline transition conditions — completed during implementation after ephemeral E2E exposed the validator gap.

### During Implementation (Add to Spec)

1. Record RED/GREEN evidence and exact files in Implementation Status.
2. Keep the generated registry diff scoped to the new Sales event.

### Post-Implementation (Follow Up)

1. Assess whether a platform transactional outbox is required before proposing stronger producer guarantees upstream.

## Recommendation

**Ready to implement.**
