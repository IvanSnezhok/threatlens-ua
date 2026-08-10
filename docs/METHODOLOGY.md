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

A polygon and a glyph are different claims and are governed separately. A fill says the state
concerns this territory or something inside it that has no outline of its own; a weapon-class glyph
says that class is *here*. Only the second is strong enough to be worth restricting, so it is
restricted:

- An icon is emitted only for a territory a source literally named, or for the nearest territory with
  an outline above a named place that has none. An ancestor lit merely because a territory inside it
  was named is no longer lit at all — the named territory has its own outline and carries the state
  itself — and it never gets an icon.
- A location the classifier related as `mentioned` — which is what it assigns to transit («повз
  Миколаїв») and as the fall-through for any name found in the text — appears in the territory panel
  and produces no icon.
- A place is only "named" when the message writes its name as a whole word, in some case Ukrainian
  actually forms. A name found inside a longer word is not a mention of that place: «Баришівку» does
  not name Бар, «Обухівку» does not name Обухів, and «південно-західний» names no settlement at all.
  Where a name has two referents in the catalogue and the message does not say which — two Південне,
  two Городок — nothing is named, because publishing either one would tell half the subscribers a
  threat is somewhere it is not.
- A message written in the past tense asserts nothing about now. A summary bulletin («у ніч на 08
  серпня», «за попередніми даними», «збито/подавлено»), a narrative essay about last night, or an
  after-action account raises no threat and puts no place on the map, even when it names weapons and
  cities — which they all do, and which is why they used to. The exception is the whole of the safety
  argument: a message that *also* states something happening now — a course, an arrow bulletin, a
  national «загроза застосування», a time-to-impact, a shelter instruction, a verb of motion in the
  present tense — is read exactly as it was before. Missing a retrospective costs a reader one wrong
  line; suppressing a warning costs them the warning, so the rules are built to make only the first
  mistake. Between the two sits a grey band that publishes by default and where, if an operator has
  switched it on, a model may be asked one question whose only possible effect is to withhold.
- An assessment becomes an icon only at `significant` or above. The analytical **contour** keeps the
  lower `elevated` floor, because a dotted outline is a hint about a territory and a glyph is a claim
  about a class.
- An analytical `(threat class, level)` pair carried by more than twenty territories in one snapshot
  produces no icons at all. A national-scope classification is propagated to every oblast as a
  low-relevance posture signal, and twenty-seven grey glyphs would be geography invented from a
  warning nobody localised.

Polygons carry no zoom model at all: a raion that a source named is lit at every zoom, the
country-wide view included, and the quiet raions of the same oblast stay dark. The **icons** do carry
one, and the asymmetry is worth stating plainly: **a threat reported only for a raion carries no icon
below zoom 6.8.** The stacks anchor to oblasts below that zoom and to raions above it, because a
glyph is a claim about a weapon class over a point and 136 such claims do not survive an overview.
Below 6.8 the threat is a lit raion polygon, a card in the event list and a territory panel —
visible, but not as a weapon-class glyph. The oblast above the raion is an ancestor of a named
territory, which receives neither an icon nor a fill: the lit raion inside it has already said
everything the source said, and filling the oblast would say more.

## Tactical comparison

The attacks page opens with a block that answers one question the three period tabs could not: **what
is different about the last day**. The tabs each describe a window, they overlap, and their
denominators differ, so a reader comparing «доба» with «місяць» is doing arithmetic the page never
did. `src/services/attack-tactics.ts` does it once, in SQL, and publishes the result.

**Two windows, no overlap.** CURRENT is `[now − 24h, now)`; BASELINE is `[now − 15d, now − 24h)` —
fourteen whole days ending exactly where the current window starts. Both count `message_classifications`
whose `decision` asserts a threat (`event_created`, `event_merged`, `redirect`), which is the same line
between an assertion and a refusal the rest of the analytics draw. Methodology version `tactics-v1`.

**Three floors, chosen before the data was looked at.**

- Fewer than **12** asserting messages in the current window and the pass emits nothing at all — not
  an empty block, not a "quiet day" row. Under that, every share is a fraction with a single-digit
  denominator and the detections would be firing on the difference between two monitoring channels
  being awake and one of them being asleep.
- A detection about a *share* needs **5** current messages behind it before it is named.
- Fewer than **20** baseline messages and only the `new_*` detections survive: a thin baseline makes
  every current share look like a change, and "this class was never named before" is still true when
  the archive is young because it is a statement about absence rather than about a proportion.

**Seven comparisons, each with a threshold and a sentence.**

| detection | fires when |
| --- | --- |
| `weapon_mix_shift` | a class's share of weapon mentions moved by ≥ 0.15 between the windows |
| `new_weapon_class` | a class with 0 baseline messages reaches 5 in the current window |
| `launch_hour_shift` | the 22:00–06:00 share moved by ≥ 0.20, **or** the busiest fixed three-hour band moved by ≥ 3 hours while carrying ≥ 25 % of the day |
| `territory_expansion` | an oblast with 0 baseline mentions is named ≥ 3 times today |
| `territory_concentration` | the busiest oblast's share of territory mentions moved by ≥ 0.20 |
| `wave_cadence_change` | the median wave duration moved by ≥ 40 % with ≥ 3 waves on each side, **or** waves per day moved by ≥ 1.0 |
| `redirect_corridor` | an ordered oblast pair (withdrawn → asserted, `decision='redirect'`) repeats ≥ 3 times today while the baseline daily rate is at most half of today's |

Waves are clustered by the same `clusterWaves()` the period tabs use — imported, not reimplemented, so
a night cannot contain one number of waves in one block and another number two screens below it.

**Every sentence is re-derivable from the row beside it.** Each detection stores the two values it
compared, the message counts underneath them, the signed movement and the evidence the sentence
quotes; the sentence itself contains no number that is not in that record. The unit suite asserts
exactly that, with the same grounding walk that guards the analytics narrative.

### The vocabulary: observed, derived, calculated

Three words, and only the first two may ever reach a reader.

- **observed** — a source said it. The threat feed, the direction quotations, the alert state.
- **derived** — we counted what already happened. The attacks page, and both tactical tables, which
  carry `data_nature = 'derived'` as a CHECK rather than as a convention.
- **calculated** — an extrapolation forward. Operator-only by construction, stored behind its own
  table prefix and its own isolation test, and absent from the tactical migration entirely.

### What the tactical block is not

It is not a forecast, and the distinction is a matter of tense rather than of confidence. Every
detection is a statement about two windows that have already closed. Nothing here names a next target,
computes a probability, or describes an interval that has not happened. The prose beneath the
detections — deterministic by default, a model's rewording only when an operator switches
`codex_settings.tactics_enabled` on — is passed through the closed forecasting lexicon in
`src/domain/forecast-guard.ts` and discarded whole if it slips into the future tense, alongside three
other checks: a number the detections do not contain, a weapon class they do not name, and an oblast
they do not name. Any one of them rejects the entire paragraph, never the offending sentence, and the
page falls back to the deterministic text that was written before the model was asked.

## Publication

Assessments are recomputed when something they describe actually changes: a relevant recorded event
arms a pass behind an operator-set debounce, bounded by a maximum delay so a continuous stream cannot
postpone it indefinitely, and by an operator-set minimum interval between completed passes (five
seconds to fifteen minutes, one minute by default). A pass the interval refuses is retried when the
interval expires rather than dropped. The fifteen-minute timer remains as the floor beneath all of
it, so a quiet period is still reassessed and a restart loses nothing but a pending window. A public update is generated when the level
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
