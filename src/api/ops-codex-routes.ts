import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';
import { beginCodexLogin, cancelPendingLogin, codexStatus, disconnectCodex } from '../services/codex-auth.js';
import { listCodexModels } from '../services/codex-client.js';
import {
  CLASSIFIER_MODES, CODEX_EFFORTS, CODEX_SERVICE_TIERS, readCodexSettings, resolveSettings, saveCodexSettings
} from '../services/codex-settings.js';
import { shadowAgreement } from '../services/shadow-classifier.js';
import { modelContextOverview } from '../services/model-context.js';
import { config } from '../config.js';
import { enrichmentReport } from '../services/analytical-enrichment.js';
import { withdrawAnalyticalEvent } from '../repositories/events.js';
import {
  CONFIRMATION_WINDOW_MINUTES,
  OUTCOME_GRACE_MINUTES,
  PRECISION_THRESHOLDS,
  analyticalPrecision
} from '../services/analytical-outcomes.js';

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

/**
 * Operator-only Codex sign-in and model settings.
 *
 * Every route here is behind the same Basic auth as the rest of `/ops`, and none of them ever
 * returns a token. `GET` answers "is there a session, whose is it, and when does it die"; that is
 * what an operator needs to decide whether to press the button, and it is all a compromised ops
 * password would yield beyond what it already yields. `/ops/codex/settings` adds the other half —
 * which model, and for which of the surfaces — and holds nothing secret at all.
 *
 * The OAuth callback itself is deliberately *not* a route on this server. It arrives on the
 * loopback listener that `beginCodexLogin` binds, because the redirect must be
 * `http://localhost:<port>/auth/callback` and this app is reached through Caddy on another port
 * entirely. Putting it here would mean registering a path that the authorisation server will never
 * call.
 */
const opsCodexRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/codex', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    return codexStatus();
  });

  /**
   * POST because it mutates: it binds a port and creates a single-use verifier, cancelling any
   * sign-in already in progress. The response is the URL to open — the server cannot open a browser
   * on the operator's machine, and should not pretend it can by redirecting.
   */
  app.post('/ops/codex/login', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    try {
      const started = await beginCodexLogin();
      return { ...started, redirectUri: (await codexStatus()).redirectUri };
    } catch (error) {
      request.log.error({ error }, 'codex login could not start');
      return reply.code(503).send({ error: 'login_unavailable', reason: String(error) });
    }
  });

  app.delete('/ops/codex/login', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    cancelPendingLogin();
    return { cancelled: true };
  });

  app.delete('/ops/codex', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    return { disconnected: await disconnectCodex() };
  });

  /**
   * Everything the settings form needs, in one request.
   *
   * Catalogue, current choice *and* session status together, because they are only meaningful
   * together: a model list is useless without knowing whether a call can be made at all, and a
   * switch set to "on" beside a dead session is the single most confusing state this feature can be
   * in. Fetching them separately would let the console render three views of three different
   * moments.
   *
   * The catalogue is asked of the service on every read rather than cached. It is one small request
   * behind an operator-only route that a human opens by hand, and a cache here would exist purely to
   * serve an operator a stale list at the exact moment they came to change something.
   */
  app.get('/ops/codex/settings', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const [stored, catalogue, status] = await Promise.all([
      readCodexSettings(), listCodexModels(), codexStatus()
    ]);
    return {
      settings: resolveSettings(stored),
      availableModels: catalogue.models,
      modelsSource: catalogue.source,
      modelsError: catalogue.error,
      status
    };
  });

  /**
   * PUT, not PATCH, because the console sends the whole form — but the body is validated as a patch
   * so that a curl that only wants to switch one feature off does not have to restate the model. An
   * empty or absent `model` means "defer to CODEX_MODEL", which is a real choice and not a mistake.
   */
  const settingsBody = z.object({
    model: z.string().max(120).nullish(),
    // Швидкість виклику: глибина міркування й черга обслуговування (міграція 047). Значення поза
    // словником не приймається тут, а не мовчки виправляється далі — оператор має побачити 400, а
    // не дізнатися про хибний вибір із поведінки моделі під час події.
    effort: z.enum(CODEX_EFFORTS).nullish(),
    serviceTier: z.enum(CODEX_SERVICE_TIERS).nullish(),
    // Хто класифікує (міграція 049): `rules` або `codex`. Режим, а не перемикач — див. codex-settings.
    classifierMode: z.enum(CLASSIFIER_MODES).nullish(),
    features: z.object({
      narrative: z.boolean(),
      digest: z.boolean(),
      attacks: z.boolean(),
      // The shadow classifier, off by default. Listed here like the rest rather than behind its own
      // route: an operator switching model use on and off wants one form, and a switch reachable
      // only by a different path is a switch nobody finds when the quota runs out.
      shadow: z.boolean(),
      // Grants the model narrowly bounded publication authority: only high-confidence assertions
      // missed by the deterministic classifier, always as `unverified`, to both public event
      // surfaces and the normal Telegram outbox. It can never withdraw an event or alter alerts.
      analytical_threats: z.boolean(),
      // Lets the model record what it read ON TOP of an event the rules published — a course, a
      // further settlement, a sharper class (migration 045). Off by default and deliberately not
      // implied by the switch above it: this one annotates a claim that already exists, while that
      // one fills a gap where none does. What it writes lands in `analytical_enrichments` and is read
      // by `/ops/analytical-enrichments` alone — no map, no Telegram, no notification.
      analytical_enrichment: z.boolean(),
      // The retrospective gate (migration 025), off by default. With it on, a model may convert a threat the
      // rules would have published into an archive-only row, and may do nothing else. It belongs on
      // the same form for the same reason as `shadow` — the operator turning model use off in a
      // hurry must find every switch in one place — and its blast radius is documented beside it in
      // `src/services/retrospective-gate.ts`.
      retrospective_gate: z.boolean(),
      // The commentary under the public tactical block (migration 033), off by default. The first
      // switch on this form whose text reaches a public page directly: the detections themselves are
      // computed in SQL and published whatever this says, and the prose above them is rejected whole
      // if it names a number, a threat class or an oblast the detections do not, or if it slips into
      // forecasting (`src/domain/forecast-guard.ts`).
      tactics: z.boolean(),
      // The operator-only oblast research memo (migration 033), off by default. Never scheduled and
      // never published — it exists only while an operator is looking at it in this console.
      attack_research: z.boolean(),
      // Attack statistics and Poisson probabilities per region from open sources (migration 048),
      // off by default. The only switch on this form that publishes a calculation about the future
      // — the chance that a day is a day of attack — on the public attacks page and in the nightly
      // analytics digest, always under a disclaimer and never anywhere near an alert.
      attack_stats: z.boolean(),
      // Risk assessment through Codex instead of the AI_* endpoint (migration 049): same index, same
      // clamp, one more reader of the per-location context. Off by default.
      risk: z.boolean()
    }).partial().optional()
  });

  /**
   * Контексти по локаціях (міграція 049): скільки їх, скільки важать, які найбільші й коли їх востаннє
   * стискали. Читання, нічого не рахує; самі тексти сюди не віддаються — їх читає лише модель.
   */
  app.get('/ops/model-contexts', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const overview = await modelContextOverview(15);
    return {
      ...overview,
      settings: {
        enabled: config.MODEL_CONTEXT_ENABLED,
        maxTokens: config.MODEL_CONTEXT_MAX_TOKENS,
        compactToTokens: config.MODEL_CONTEXT_COMPACT_TO_TOKENS,
        requestTokens: config.MODEL_CONTEXT_REQUEST_TOKENS,
        retentionDays: config.MODEL_CONTEXT_RETENTION_DAYS,
        compactionTimeoutMs: config.MODEL_CONTEXT_COMPACTION_TIMEOUT_MS
      },
      classifier: {
        timeoutMs: config.CODEX_PRIMARY_TIMEOUT_MS,
        maxPerMinute: config.CODEX_PRIMARY_MAX_PER_MINUTE,
        maxConcurrent: config.CODEX_PRIMARY_MAX_CONCURRENT,
        minConfidence: config.CODEX_PRIMARY_MIN_CONFIDENCE
      }
    };
  });

  app.put('/ops/codex/settings', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_settings', issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    }
    const saved = await saveCodexSettings(parsed.data);
    return { settings: resolveSettings(saved) };
  });

  /**
   * How often the shadow classifier and the rules agree, and the newest cases where they did not.
   *
   * This is the whole point of the shadow feature made readable: the disagreements are the messages
   * worth a human's attention, and the percentage is the only honest way to say whether the rules
   * have started drifting from the language the channels actually use. Nothing here can be acted on
   * automatically — the output is a reading list, and the action it leads to is somebody writing a
   * pattern and a test.
   *
   * The window is bounded at a month and the sample at a hundred because both numbers reach a
   * sequential scan over a table that grows with every ingested message, behind a route an operator
   * refreshes by hand.
   */
  const agreementQuery = z.object({
    hours: z.coerce.number().int().min(1).max(720).default(24),
    examples: z.coerce.number().int().min(1).max(100).default(10)
  });

  app.get('/ops/shadow-classifier', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const parsed = agreementQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return shadowAgreement(parsed.data.hours, parsed.data.examples);
  });

  /**
   * What became of the promotions, and therefore where `ANALYTICAL_THREAT_MIN_CONFIDENCE` belongs.
   *
   * `/ops/shadow-classifier` above answers «how often do the rules and the model disagree»; this
   * route answers the only question that follows once the model is allowed to publish those
   * disagreements — «and how often was it right». The precision is reported at three thresholds
   * around the shipped default rather than at the one in force, because the decision an operator is
   * making is a comparison: raising the floor buys precision and costs promotions, and both numbers
   * have to be on the screen at once for that trade to be visible.
   *
   * `currentThreshold` rides along so the row an operator is standing on is identifiable without
   * cross-referencing the settings page, and the methodology rides along for the same reason it does
   * in `./ops-source-trust-routes.ts`: a precision figure without its windows and its exclusions is a
   * number that can only be believed or disbelieved.
   *
   * Nothing here writes anything. Moving the threshold is a human editing a setting; this route
   * deliberately offers no way to do it, because a page that both measures the model and adjusts the
   * model's authority is one accidental click away from a feedback loop `CONTEXT.md` forbids.
   *
   * The window is bounded at a year and the failure sample at fifty for the same reason the
   * agreement route is bounded: both reach an operator-refreshed table scan, and neither answer gets
   * better past those sizes.
   */
  const precisionQuery = z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
    failures: z.coerce.number().int().min(1).max(50).default(10)
  });

  app.get('/ops/analytical-outcomes', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const parsed = precisionQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const report = await analyticalPrecision(parsed.data.days, parsed.data.failures);
    return {
      ...report,
      methodology: {
        thresholds: PRECISION_THRESHOLDS,
        graceMinutes: OUTCOME_GRACE_MINUTES,
        confirmationWindowMinutes: CONFIRMATION_WINDOW_MINUTES,
        notice: 'Точність рахується лише за промоціями, вікно чинності яких уже минуло. '
          + '«Підтверджено офіційно» означає, що офіційна тривога ПОЧАЛАСЬ над тією ж територією '
          + 'після публікації моделі; промоції, зроблені під час уже активної тривоги, підтвердити '
          + 'у такий спосіб неможливо — вони показані окремо як «undecidable» і не входять у '
          + 'знаменник. «Підтверджено незалежно» — це твердження іншої групи незалежності про той '
          + 'самий тип загрози; збіг двох моделей підтвердженням не рахується. Поріг '
          + 'ANALYTICAL_THREAT_MIN_CONFIDENCE не змінюється автоматично: ця сторінка лише показує, '
          + 'куди його варто рухати.'
      }
    };
  });

  /**
   * What the model saw that the rules published nothing about.
   *
   * The third reading list, and the one that answers a question the other two cannot. `/ops/shadow-
   * classifier` shows disagreements, which on a published message are rare — the two sides usually
   * agree about a post the rules accepted. `/ops/analytical-outcomes` scores what the model published
   * on its own. Neither can show the case this route exists for: the rules read the message
   * correctly, and the model read something MORE in it — a course, a second settlement, a sharper
   * weapon class — which until migration 045 went nowhere at all.
   *
   * This is the whole surface of that feature. The rows live in `analytical_enrichments`; no public
   * read joins that table, no notification is derived from it, and the event it annotates is not
   * touched by its existence. Showing enrichments to readers would be a different decision with a
   * different argument, and it has not been taken — so an operator reading this page is reading
   * material for a human judgement (is the model seeing something the rules should learn?), exactly
   * as with the agreement report.
   *
   * Bounded at a week rather than at a month like its neighbours: the useful reading is «what did the
   * model add last night», and a longer window on a table that grows with every published event turns
   * an operator's refresh into a scan.
   */
  const enrichmentQuery = z.object({
    hours: z.coerce.number().int().min(1).max(168).default(24),
    examples: z.coerce.number().int().min(1).max(100).default(20)
  });

  app.get('/ops/analytical-enrichments', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const parsed = enrichmentQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return enrichmentReport(parsed.data.hours, parsed.data.examples);
  });

  /**
   * The button that takes one wrong analytical pin off the map now, instead of in half an hour.
   *
   * Every other route in this file reads. This one writes to a public surface, so the reasoning for
   * why it is allowed to exist lives next to it rather than only in the repository:
   *
   *  - It can reach **only** `origin='model'` events. That is enforced in the UPDATE inside
   *    `withdrawAnalyticalEvent` (src/repositories/events.ts), not here — this route deliberately
   *    holds no authority of its own beyond calling it, so a mistake in this file cannot widen what
   *    the withdrawal can touch. An id belonging to a deterministic or human-sourced event comes back
   *    `not_model` and nothing was written.
   *  - It cannot touch `alert_source_states` or `alert_periods`. There is no code path from here to
   *    them; an official tribute stays official whatever an operator thinks of the model.
   *  - `reason` is mandatory and its floor is eight characters (CHECK in migration 042), because the
   *    audit row is the reason this capability is acceptable and «ні» is not a reason.
   *
   * The path is `/ops/analytical-threats/:eventId/withdraw` rather than `DELETE /ops/threats/:id`:
   * the noun in the URL states the only class of event this reaches, so a runbook line pasted with
   * the wrong id fails on the noun before it fails on authority.
   *
   * The refusals are reported apart (`not_found` / `not_model` / `not_live`) with distinct status
   * codes, because an operator pressing this needs to know whether they used the wrong id, aimed at a
   * human event, or were beaten to it by the expiry sweep — and 404 for all three would hide the one
   * answer that matters. 409 for `not_model` rather than 403: the refusal is about what the *event*
   * is, not about who is asking.
   */
  const withdrawalParams = z.object({ eventId: z.string().uuid() });
  const withdrawalBody = z.object({
    // The same 8..500 bounds the CHECK enforces, restated here so the caller gets a 400 with a named
    // field instead of a 500 out of a constraint violation. Kept in both places on purpose: the
    // constraint is the guarantee, this is the error message.
    reason: z.string().trim().min(8).max(500)
  });

  app.post('/ops/analytical-threats/:eventId/withdraw', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const params = withdrawalParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_event_id' });
    const body = withdrawalBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_withdrawal', issues: body.error.issues.map((issue) => issue.path.join('.'))
      });
    }
    const result = await withdrawAnalyticalEvent(params.data.eventId, {
      reason: body.data.reason,
      // The account from the Basic header, and never a value the client can choose. `authorised`
      // above has already verified it against `config.OPS_USER`, so the audit row names an identity
      // the request actually proved rather than one it asserted.
      withdrawnBy: opsActor(request),
      mode: 'operator'
    });
    if (result.outcome === 'not_found') return reply.code(404).send({ error: 'unknown_event' });
    if (result.outcome === 'not_model') {
      return reply.code(409).send({
        error: 'not_a_model_event',
        origin: result.origin,
        detail: 'Ця подія створена детермінованими правилами. Відкликати можна лише аналітичні події моделі.'
      });
    }
    if (result.outcome === 'not_live') {
      return reply.code(409).send({ error: 'event_not_live', status: result.previousStatus });
    }
    request.log.warn(
      { eventId: result.eventId, previousStatus: result.previousStatus },
      'analytical threat event withdrawn by operator'
    );
    return {
      withdrawn: true,
      eventId: result.eventId,
      previousStatus: result.previousStatus,
      version: result.version
    };
  });
};

/**
 * The operator name out of the Basic credentials, for the audit row only.
 *
 * `hasValidOpsAuth` has already compared both halves against the configured pair by the time this
 * runs, so the username here is verified rather than claimed; it is re-decoded instead of being
 * returned from that check so that `ops-auth.ts` keeps its single job of answering yes or no. The
 * fallback exists because this must never be the thing that throws — an audit row naming `unknown`
 * is worth more than a 500 that leaves a false pin on the map.
 */
function opsActor(request: FastifyRequest): string {
  const authorization = request.headers.authorization ?? '';
  if (!authorization.startsWith('Basic ')) return 'unknown';
  const user = Buffer.from(authorization.slice(6), 'base64').toString().split(':')[0];
  return user?.trim() || 'unknown';
}

export default opsCodexRoutes;
export { opsCodexRoutes };
