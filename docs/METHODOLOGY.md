# Risk methodology v2

The published number answers one narrow question: how strong are current public signals that an official warning of the specified type may appear for this location within six hours?

It does not estimate a target, impact, exact route, number of weapons or personal safety.

## Inputs

- explicit official or monitored threat statements;
- reported directions without route extrapolation;
- activity of strategic aviation, MiG-31K, missile carriers and launch systems;
- UAV launch/activity signals;
- source tier, independence group, age and geographic relevance.

National posture signals are propagated to regions with low geographic relevance. A city signal may also contribute to its parent oblast, but the original event geography remains unchanged.

## Weighting

Each signal has a configured base contribution and reliability. Its effective contribution has a two-hour half-life:

```text
effective = contribution × reliability × 2 ^ (−age_hours / 2)
```

The deterministic fallback sums effective contributions. A configured AI model may explain and adjust the index, but the server overwrites its location, threat type and horizon, rejects invented signal identifiers and applies the same hard limits.

## Bands and hard limits

| Score | Public level |
|---:|---|
| 0.0–1.9 | background |
| 2.0–3.9 | elevated |
| 4.0–5.9 | significant |
| 6.0–7.9 | high |
| 8.0–10.0 | very high |

- Only Tier C evidence: maximum `3.9/10`, confidence `low`.
- No Tier A evidence: maximum `5.9/10`.
- Fewer than two independent source groups: confidence `low`.
- High confidence without Tier A is reduced to medium.
- A jump above three points without Tier A is rejected.

The displayed percentage is the score multiplied by ten. It is explicitly called an **indicative level**, not a statistical probability.

## Publication

Assessments run every 15 minutes. A public update is generated when the level changes, the score moves by at least 0.5, or the methodology/model version changes. Superseded assessments remain auditable. A digest is queued after 23:20 Europe/Kyiv once per user and date.
