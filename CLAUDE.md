# ThreatLens UA

Read `CONTEXT.md` before changing domain behavior. Preserve the civil-threat safety boundaries: official alerts outrank analysis; a model never touches official alerts and never issues an all-clear. In the default `rules` mode, AI or shadow classification must never mutate live events, map state, risk, or notifications; in the owner-chosen `classifier_mode=codex` (ADR 0002) the model is the primary classifier and its verdict creates events with the source's evidence — every model failure, timeout, budget refusal or low confidence falls back to the rules, so a warning is never lost.

## Agent skills

### Issue tracker

Work is tracked in GitHub Issues for `IvanSnezhok/threatlens-ua`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use labels that describe the issue type and affected module; do not introduce workflow-state labels unless the owner explicitly requests them. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository rooted at `CONTEXT.md`; consult relevant ADRs if `docs/adr/` exists. See `docs/agents/domain.md`.

## Engineering constraints

- Diagnose performance with repeatable measurements before modifying code.
- Preserve existing user changes and do not publish, commit, or push without explicit authorization.
- Prefer bounded work, backpressure, caching, batching, and indexed queries over scaling resource limits.
- Public endpoints must remain safe for many concurrent readers; never add per-client polling or unbounded in-memory state.
- Validate changes with focused tests, typecheck, lint, and an appropriate load or resource benchmark.
