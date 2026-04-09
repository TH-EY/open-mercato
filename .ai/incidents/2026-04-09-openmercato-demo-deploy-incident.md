# Incident Report — Open Mercato DEMO deploy / CloudFormation-ECS rollout

**Date:** 2026-04-09  
**Environment:** DEMO / internal  
**System:** `openmercato`  
**Region:** `eu-west-2`  
**Severity:** Internal operational incident  
**Final status:** Resolved

---

## Summary

During a DEMO deployment, the `openmercato` CloudFormation stack entered unstable update/rollback states and remained blocked for hours on `WebService`.

The application itself was intermittently healthy, but CloudFormation could not complete because the ECS rollout for the web service was repeatedly destabilized by load balancer target health issues and, most likely, by interference from the custom target-sync mechanism.

The incident was resolved by stabilizing ALB health checks, disabling the custom target-sync EventBridge rules, removing the stale unhealthy target from the target group, and allowing ECS to reach a clean steady state.

Final outcome:
- CloudFormation stack: `UPDATE_COMPLETE`
- Drift status: `IN_SYNC`
- Web service: stable
- Worker service: stable
- `/login`: HTTP 200

---

## Impact

- DEMO environment experienced periods of web downtime / instability
- CloudFormation remained blocked for an extended period
- Web rollout repeatedly restarted or stalled
- Worker service and core app functionality were eventually restored and stabilized

Because this was an internal DEMO environment, external customer impact was negligible.

---

## Timeline

### Initial failure pattern

The deployment entered unhealthy CloudFormation states including:
- `UPDATE_ROLLBACK_FAILED`
- later prolonged `UPDATE_IN_PROGRESS`

The primary long-running blocker became:
- `WebService = UPDATE_IN_PROGRESS`

### Recovery phase

Key recovery actions taken:

1. Recovered the stack from rollback-failed state into a stable rollback-complete state
2. Switched Redis away from the problematic stack-owned parameter group to:
   - `openmercato-redis-temp-20260408`
3. Reconciled the stack against the currently known-good immutable app image:
   - `062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:query-index-fix-20260408-212322`
4. Corrected ALB health check settings for the shared web target group:
   - path `/login`
   - timeout `10`
   - interval `15`
   - healthy threshold `2`
   - unhealthy threshold `2`
5. Disabled custom target-sync EventBridge rules:
   - `openmercato-they-lb-task-state-sync`
   - `openmercato-they-lb-scheduled-sync`
6. Removed the stale unhealthy target still present in the target group
7. Waited for ECS web rollout to complete and for CloudFormation to finish update processing

### Resolution

Confirmed final state:
- Stack `openmercato` = `UPDATE_COMPLETE`
- `WebService` = `UPDATE_COMPLETE`
- `WorkerService` = `UPDATE_COMPLETE`
- ECS web rollout = `COMPLETED`
- ECS worker rollout = `COMPLETED`
- Target group contains only healthy active target(s)
- `https://demo.openmercato.com/login` returns `HTTP 200`
- CloudFormation drift detection = `IN_SYNC`

---

## Root cause

### Most likely root cause

The most likely root cause was **operational interference between native ECS target registration/deregistration and the custom load balancer target-sync mechanism**.

This manifested as:
- stale unhealthy targets remaining in the target group
- repeated task recycling by ECS
- prolonged or reset ECS deployment lifecycle stages
- CloudFormation waiting for `WebService` to finish even when the app itself was already healthy

### Contributing factors

1. **Aggressive / unsuitable health-check behavior during rollout**
   - earlier target failures included timeout/unhealthy states

2. **1-task service sensitivity**
   - the web service runs with `desiredCount=1`, so rollout instability has an outsized effect

3. **Complex recovery sequence**
   - rollback recovery
   - manual ECS interventions
   - CloudFormation reconciliation
   all increased control-plane complexity during the incident

4. **Redis parameter-group ownership issue**
   - this was not the final blocker for the web rollout, but it complicated stack recovery and rollback handling earlier in the incident

---

## Evidence

### Evidence that this was not primarily an application crash

- Web logs showed normal startup and graceful shutdown sequences
- No fresh fatal application exceptions were found during the final blocked phase
- Stopped ECS tasks exited with code `0`
- `/login` intermittently returned `200` even while CloudFormation still waited on `WebService`

### Evidence pointing at ECS / ALB / control-plane behavior

- ECS repeatedly replaced web tasks during the deployment
- ECS events showed deregistration / draining / restarts
- A stale unhealthy target coexisted alongside a healthy active target
- ECS deployment lifecycle remained in progress even after app health recovered
- After disabling target-sync rules and removing the stale target, rollout converged

---

## What fixed the incident

The incident was resolved by the following actions:

1. **Use immutable image for reconciliation**
   - Avoided ambiguity from non-fixed image references

2. **Use external Redis parameter group**
   - Removed Redis parameter-group ownership as a rollback blocker

3. **Stabilize ALB health checks**
   - `/login`
   - timeout `10`
   - interval `15`
   - healthy `2`
   - unhealthy `2`

4. **Disable custom target-sync rules**
   - Prevented further automated interference during ECS deployment

5. **Remove stale unhealthy target**
   - Cleared the old target from the target group so only the active healthy target remained

6. **Allow ECS and CloudFormation to settle**
   - ECS reached steady state
   - CloudFormation completed
   - drift returned to `IN_SYNC`

---

## Preventive actions

### P0 — highest priority

#### 1. Rework or remove custom target-sync for ECS-managed services

If ECS already manages target registration for the service, we should not run an overlapping custom sync mechanism unless there is a very strong reason.

**Action:**
- remove target-sync from this service path entirely, **or**
- scope it so it cannot deregister active ECS-managed rollout targets

#### 2. Add structured logs to the target-sync lambda

Current logging is too weak to confidently diagnose target registration behavior.

**Action:**
- log discovered desired targets
- log currently registered targets
- log every register/deregister decision
- log the exact reason for deregistration

### P1 — important

#### 3. Keep stable health-check settings for DEMO

Leave the target group health checks at:
- `/login`
- timeout `10`
- interval `15`
- healthy `2`
- unhealthy `2`

#### 4. Keep immutable image deployment policy

Always deploy using explicit immutable image tags.

#### 5. Keep Redis parameter-group handling decoupled from app rollouts

Do not combine:
- app deploys
- Redis ownership cleanup
- stack recovery work

in a single risky operation.

### P2 — process improvements

#### 6. Add pre-deploy checklist

Before deploy:
- stack not in rollback-failed / drifted recovery state
- ECS services stable
- target group free of stale unhealthy targets
- `/login` returns `200`
- no extra active ECS deployments for web service

#### 7. Add post-deploy checklist

After deploy:
- CloudFormation `UPDATE_COMPLETE`
- ECS web rollout `COMPLETED`
- ECS worker rollout `COMPLETED`
- target group contains only expected healthy target(s)
- `/login` returns `200`
- drift detection returns `IN_SYNC`

#### 8. Add alerting for mixed healthy/unhealthy target states

Especially for single-task services, an alert should fire when:
- one target is healthy
- another stale target for the same service remains unhealthy

This would have reduced diagnosis time significantly.

---

## Final validated state

Validated after incident resolution:

- Stack: `UPDATE_COMPLETE`
- Drift: `IN_SYNC`
- Web service:
  - task definition `openmercato-web:57`
  - rollout `COMPLETED`
  - `running=1`
  - `pending=0`
- Worker service:
  - task definition `openmercato-worker-worker:56`
  - rollout `COMPLETED`
  - `running=1`
  - `pending=0`
- Target group:
  - active target healthy
- App:
  - `https://demo.openmercato.com/login` → `HTTP 200`

---

## Recommended follow-up owner actions

1. Review whether `TheyLoadBalancer*Sync*` resources are still needed for ECS web service
2. If kept, redesign them to be ECS-aware and safe during rolling deployments
3. Document DEMO deploy runbook with:
   - preflight checks
   - rollback recovery steps
   - post-deploy validation
4. Keep this incident linked from deploy/runbook documentation

