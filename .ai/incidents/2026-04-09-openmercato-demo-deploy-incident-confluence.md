# Open Mercato DEMO — Incident Report (Confluence / Jira version)

## Incident

**Title:** CloudFormation / ECS deploy incident on DEMO environment  
**Date:** 2026-04-09  
**Environment:** DEMO / internal  
**System:** `openmercato`  
**Region:** `eu-west-2`  
**Final status:** Resolved

---

## Summary

During a DEMO deployment, the `openmercato` CloudFormation stack entered unstable update/rollback states and remained blocked on `WebService`.

The application itself was intermittently healthy, but CloudFormation could not complete because the ECS rollout for the web service was repeatedly destabilized by ALB target-health behavior and most likely by interference from the custom target-sync mechanism.

The incident was resolved by:
- stabilizing ALB health checks
- disabling the custom target-sync EventBridge rules
- removing the stale unhealthy target from the target group
- allowing ECS and CloudFormation to converge to a clean steady state

---

## Business impact

- DEMO web environment experienced temporary instability / downtime
- deployment pipeline remained blocked for an extended period
- no external customer impact

Because this was an internal DEMO environment, the business impact was limited.

---

## Technical impact

- CloudFormation entered rollback/update failure states
- `WebService` remained stuck in `UPDATE_IN_PROGRESS`
- ECS web rollout recycled tasks multiple times
- stale unhealthy ALB target remained alongside the active healthy target
- worker service was less affected and ultimately stabilized earlier

---

## Root cause

### Primary root cause

Most likely operational conflict between:
- native ECS target registration/deregistration
- custom load balancer target-sync automation

This resulted in stale / unhealthy targets remaining in the target group and prevented clean convergence of the ECS deployment lifecycle.

### Contributing factors

- single-task web service (`desiredCount=1`) is more sensitive to rollout instability
- health-check behavior was initially too fragile for this rollout pattern
- recovery required multiple control-plane interventions
- Redis parameter-group ownership issues complicated earlier rollback handling

---

## Resolution

The incident was resolved by:

1. Recovering the stack from rollback failure into a deployable state
2. Using external Redis parameter group:
   - `openmercato-redis-temp-20260408`
3. Reconciling against immutable image:
   - `062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:query-index-fix-20260408-212322`
4. Updating ALB health checks to:
   - path `/login`
   - timeout `10`
   - interval `15`
   - healthy threshold `2`
   - unhealthy threshold `2`
5. Disabling custom sync rules:
   - `openmercato-they-lb-task-state-sync`
   - `openmercato-they-lb-scheduled-sync`
6. Deregistering the stale unhealthy target from the target group
7. Waiting for ECS steady state and CloudFormation completion

---

## Final validated state

- CloudFormation stack: `UPDATE_COMPLETE`
- Drift detection: `IN_SYNC`
- `WebService`: `UPDATE_COMPLETE`
- `WorkerService`: `UPDATE_COMPLETE`
- ECS web rollout: `COMPLETED`
- ECS worker rollout: `COMPLETED`
- `/login`: `HTTP 200`
- target group: only active healthy target remains

---

## Evidence / signals observed

- application logs did not show fresh fatal app crashes during the final blocked phase
- stopped web tasks exited with code `0`
- `/login` could return `200` even while CloudFormation still waited on `WebService`
- ECS events showed repeated task replacement / deregistration / draining
- stale unhealthy target remained in target group until manually removed
- after disabling custom sync rules and removing the stale target, rollout converged

---

## Preventive actions

### P0

#### Rework or remove custom target-sync for ECS-managed services

If ECS already manages target registration, overlapping custom sync should be removed or made deployment-safe.

#### Add structured logging to target-sync lambda

Must log:
- desired targets
- currently registered targets
- register/deregister actions
- reasons for target removal

### P1

#### Keep stable ALB health-check settings for DEMO

- `/login`
- timeout `10`
- interval `15`
- healthy `2`
- unhealthy `2`

#### Keep immutable image deploy policy

Always deploy using explicit immutable image tags.

#### Keep Redis parameter-group handling decoupled from app rollout

Do not combine app rollout and Redis ownership cleanup in one risky change.

### P2

#### Add deploy preflight checklist

Before deploy:
- stack healthy
- ECS services stable
- target group free of stale unhealthy targets
- `/login` returns `200`
- no extra active ECS deployments

#### Add deploy post-checklist

After deploy:
- stack `UPDATE_COMPLETE`
- ECS web/worker `COMPLETED`
- target group healthy
- `/login` = `200`
- drift = `IN_SYNC`

#### Add alert for mixed healthy/unhealthy targets

Especially important for 1-task services.

---

## Suggested Jira follow-up tasks

1. **Investigate and redesign `TheyLoadBalancer*Sync*` resources**
2. **Add structured logging and diagnostics to target-sync lambda**
3. **Document DEMO deploy runbook with preflight / rollback / post-check steps**
4. **Add monitoring/alerting for stale unhealthy ALB targets during ECS rollout**

