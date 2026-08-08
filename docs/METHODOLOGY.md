# Risk methodology v2

The published number answers one narrow question: how strong are current public signals that an official warning of the specified type may appear for this location within six hours?

It does not estimate a target, impact, exact route, number of weapons or personal safety.

## Inputs

- explicit official or monitored threat statements;
- reported directions without route extrapolation;
- activity of strategic aviation, MiG-31K, missile carriers and launch systems;
- UAV launch/activity signals;
- source tier, independence group, age and geographic relevance;
- measured source trust — a nightly, thirty-day behavioural score per publisher (retractions, corroboration, first reports, lag, readability), consumed only as the bounded modifier below.

National posture signals are propagated to regions with low geographic relevance. A city signal may also contribute to its parent oblast, but the original event geography remains unchanged.

Threat vectors are **not** an input. The public chain is a presentation of messages this engine has already weighed one by one; feeding it back in would count the same reports twice. The operator-only extrapolation of a chain (`docs/ARCHITECTURE.md`, "Threat vectors") never reaches this engine either — it is a calculation about the future, and the index is only ever a function of what has already been reported.

## Weighting

Each signal has a configured base contribution and reliability. Its effective contribution has a two-hour half-life and is modulated by the publisher's measured trust:

```text
effective = contribution × reliability × 2 ^ (−age_hours / 2) × trust_modifier
```

`trust_modifier` is clamped to **[0.6, 1.2]** and is exactly `1.0` for a source that has never been
measured, so the assessment is complete without the trust layer. Trust modulates a contribution and
nothing else: it never changes a source's tier, and every hard limit below is applied **after** it —
no amount of measured good behaviour lifts a Tier C-only location past its cap. The bounds are
published by `/api/v1/methodology`.

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

## What the map asserts

A polygon and a glyph are different claims and are governed separately. A muted fill says the state
concerns some part of this territory; a weapon-class glyph says that class is *here*. Only the second
is strong enough to be worth restricting, so it is restricted:

- An icon is emitted only for a territory a source literally named, or for the nearest territory with
  an outline above a named place that has none. An ancestor lit merely because a territory inside it
  was named keeps its muted polygon and gets no icon.
- A location the classifier related as `mentioned` — which is what it assigns to transit («повз
  Миколаїв») and as the fall-through for any alias found in the text — appears in the territory panel
  and produces no icon.
- An assessment becomes an icon only at `significant` or above. The analytical **contour** keeps the
  lower `elevated` floor, because a dotted outline is a hint about a territory and a glyph is a claim
  about a class.
- An analytical `(threat class, level)` pair carried by more than twenty territories in one snapshot
  produces no icons at all. A national-scope classification is propagated to every oblast as a
  low-relevance posture signal, and twenty-seven grey glyphs would be geography invented from a
  warning nobody localised.

One consequence of the zoom model is worth stating plainly: **a threat reported only for a raion
carries no icon below zoom 6.8.** The raion stack appears only once the raion layer is readable, and
the oblast above it is an ancestor of a named territory, which never receives an icon. Below that
zoom the threat is a muted oblast fill, a card in the event list and a territory panel — visible, but
not as a weapon-class glyph.

## Publication

Assessments are recomputed when something they describe actually changes: a relevant recorded event
arms a pass behind an operator-set debounce, bounded by a maximum delay so a continuous stream cannot
postpone it indefinitely, and by a minimum interval of one minute between completed passes. The
fifteen-minute timer remains as the floor beneath all of it, so a quiet period is still reassessed
and a restart loses nothing but a pending window. A public update is generated when the level
changes, the score moves by at least 0.5, or the methodology/model version changes. Superseded
assessments remain auditable. A digest is queued after 23:20 Europe/Kyiv once per user and date.

The public view may additionally be **held** by a fixed cutoff. When an operator selects
`delayed_15s`, the public snapshot, the event stream, the map, the event list and the public attack
analytics are served as of `now − PUBLICATION_DELAY_SECONDS` instead of now. The hold is
presentation-only in the strict sense: collection, classification, the official alert reconciler, the
audit archive, the operator console, the metrics endpoints and **Telegram notifications** are never
delayed, and no stored value differs between the two modes. The hold may only ever delay an
appearance or extend a disappearance — never the reverse — so the delayed view reports status as of
the cutoff rather than the terminal label, and switching the mode on cannot retract anything already
published. `/api/v1/methodology` publishes the mode and the delay in force, and the map states the
hold in its own status strip, so a reader is never shown held data without being told.

Two limits of the hold are documented rather than latent:

- A `status` or `evidence_level` **upgrade** on an event that is already published is **not** held.
  The cutoff bounds when a row became visible, not every later revision of it, so a threat can be
  promoted to `confirmed` in the public view before the delay has elapsed. A district *added* to an
  already-published event is a different case and **is** held for the full cutoff, because under the
  territory model a district is a polygon and an icon stack — and it is held on every surface that
  can draw it, including the observation-chain overlay, whose nodes and segments are bounded by when
  the classification behind them was recorded. A source message attached to a published event, and
  the change-log entry recording a status transition, are held on the same terms in the event dialog.
- The delayed public attack analytics measure **two different clocks**. The window («за добу», «за
  тиждень») is measured on the source's own publication time, so a backfilled or edited post lands in
  the night it describes; the hold is applied to the instant the classification was *recorded*. A
  message published an hour ago but ingested a second ago therefore waits out the full delay before
  it is counted, exactly as the same message does on the map and in the event stream.
- The consequence family rests on a message-wide regular expression. The classifier assigns the
  `aftermath` relation when the message text anywhere contains наслідк / влучан / пошкоджен / вибух,
  without tying the word to the location alias it is labelling. That is deliberately generous, and it
  is exactly why the consequence state additionally requires `confirmed` or `official` evidence
  before a territory is hatched as an attack aftermath: one loose regular expression must not be able
  to draw a strike on the map on its own.
