# Fork Divergence Audit

Baseline snapshot for preparing this fork for future upstream contributions.

## Baseline

- Compared refs: `upstream/develop` → current fork head
- Ahead / behind: `110 / 9`
- Changed files: `1228`
- Current intent: treat existing fork changes as baseline to classify, not as a bundle to submit upstream

## Classification Rules

- `upstream-pr-candidate` – potentially reusable work that should be extracted into small, clean PRs
- `fork-only` – local delivery, infra, or product decisions that should stay on the fork track
- `missing-extension-point` – foundational work that exists because the platform needed a cleaner extension seam
- `obsolete/noise` – local state, accidental artifacts, or material that must stay out of future contribution branches

## Classified Change-Sets

| Change-set | Category | Primary areas | Fork dependencies | BC surfaces to watch | Required tests | Extraction order | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Deployment overlay, `they.dev`, AWS infra, CloudFormation, CI/CD environment tuning | `fork-only` | `infra/`, `.github/workflows/`, deployment docs | TH-EY infrastructure, AWS account topology, custom domain, cost profile | none in platform product contracts; avoid leaking env assumptions into docs/scripts | infra smoke test, deploy validation, docs spot-check | n/a | Keep on `fork/*`; never use as a base for upstream work |
| Local developer bootstrap improvements (`setup-local.sh`, `--docker`, watch/setup ergonomics) | `upstream-pr-candidate` | `scripts/`, root setup flow, selected docs | low, if separated from local infra assumptions | CLI commands, docs expectations | script smoke tests, CI install path, docs review | 4 | Good candidate for a small future extraction once detached from AWS-specific guidance |
| Universal extension foundation (widget injection, component replacement, API interceptors, response enrichers, event bridge, notification handlers, query extensibility) | `missing-extension-point` | `packages/core`, `packages/shared`, `packages/ui`, `packages/events`, related specs `SPEC-041*`, `SPEC-043`, `SPEC-048`, `SPEC-059` | medium; several downstream modules now rely on it | widget spot IDs, event IDs, import paths, API route contracts, DI names | unit + integration around injection, interceptors, event delivery | 1 | Highest-value upstream preparation area; extract in thin PRs before feature modules |
| Official modules lifecycle, standalone app support, create-app/template and CLI packaging flows | `missing-extension-point` | `packages/create-app`, `packages/cli`, docs, specs `SPEC-061` to `SPEC-067` | medium; coupled to distribution strategy | CLI commands, generated file contracts, import paths | CLI unit/integration, template smoke tests | 2 | Important to reduce future fork pressure when shipping add-on modules |
| Checkout / pay links / payment experience package and related gateway plumbing | `fork-only` (for now) | `packages/checkout`, related `packages/core`, docs, integration tests | high; large feature surface and active product shaping | API routes, event IDs, ACL features, widget spots, generated contracts | package unit tests, integration tests, end-to-end pay-link flows | 6 | Do not upstream as-is; only consider later after foundations are extracted and the scope is reduced |
| Webhooks module and delivery lifecycle work | `fork-only` (for now) | `packages/webhooks`, related docs/tests | medium; depends on broader integration direction | API routes, event IDs, ACL features | integration tests for inbound, retry, delivery audit | 5 | Candidate for later extraction only after agreeing product boundaries with upstream maintainers |
| Enterprise security stack (MFA, sudo, recovery, enforcement, provider UI) | `fork-only` (for now) | `packages/enterprise`, security docs, QA scenarios | high; enterprise roadmap and policy choices | API routes, event IDs, ACL, generated UI contracts | auth/security integration tests, QA scenarios | n/a | Keep isolated from future `contrib/*` work unless maintainers explicitly request it |
| QA/spec/process hardening and documentation additions | `upstream-pr-candidate` | `.ai/specs`, `.ai/qa`, docs, contributor process files | low to medium; depends on maintainer appetite for process changes | contributor workflow docs, test process expectations | docs review, command validation where referenced | 3 | Split into small PRs only if maintainers want the added process overhead |

## Immediate Candidate Backlog

These are the only areas worth considering for the first future upstream-ready extractions:

1. extension-point foundation slices from the `SPEC-041*` family
2. standalone/official-module lifecycle improvements that reduce fork pressure
3. setup/bootstrap improvements that are provider-agnostic
4. narrowly scoped contributor/process improvements if maintainers want them

## Explicit Fork-Only Baseline

Do not plan future upstream PRs directly from these areas:

- AWS infrastructure and deployment overlays
- `they.dev` domain and environment-specific cost tuning
- current checkout package as a whole
- current enterprise security package as a whole
- any branch that depends on fork-only deployment or branding choices

## Missing Extension Points to Design Next

These gaps should be addressed before future fork work spreads further into core:

1. deployment/provider overlays that keep CI and infra customizations outside platform-default workflows
2. setup/bootstrap hooks for fork-specific local environment flows
3. clearer module packaging/distribution seams so feature packages can evolve without patching core app scaffolding

## Obsolete / Noise to Keep Out of `contrib/*`

- `.omc/`
- `.serena/`
- root exploratory screenshots: `api-docs.png`, `dashboard.png`, `login-page.png`, `settings.png`
- accidental or unclear repository artifacts should be reviewed before any future upstream branch is cut

## Ready-State Definition

This fork is considered ready for the first real contribution when:

- local `develop` tracks `upstream/develop`
- `origin/develop` mirrors the same commit
- all future work starts on either `contrib/*` or `fork/*`
- the next candidate PR can be created without pulling history from `main`
