import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { PUBLICATION_MODES } from '../types.js';
import { publicationSlice, sliceMeta, type PublicationSlice } from '../services/publication.js';
import {
  RUNTIME_SETTINGS_BOUNDS,
  RuntimeSettingsRangeError,
  applyRuntimeSettingsPatch,
  readRuntimeSettings,
  readRuntimeSettingsAudit,
  saveRuntimeSettings,
  validateRuntimeSettings
} from '../services/runtime-settings.js';
import { hasValidOpsAuth } from './ops-auth.js';

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

function unauthorized(reply: FastifyReply) {
  return reply.header('WWW-Authenticate', 'Basic realm="ThreatLens Ops"').code(401).send({ error: 'unauthorized' });
}

/**
 * The sentence the console shows beside the mode switch, and the one an operator quotes when asked
 * what the delay actually does. It is here, next to the switch that causes it, rather than only in
 * the documentation — the person flipping it is not reading `docs/METHODOLOGY.md` at that moment.
 */
const NOTICE = 'Затримка стосується лише публічних snapshot, SSE, карти, панелі подій і аналітики. '
  + 'Збір, класифікація, аудит, /ops, метрики та Telegram-сповіщення не затримуються.';

/**
 * The bounds the CHECK constraints in migrations 022 and 028 enforce, sent to the form so the
 * numeric inputs carry their own `min`/`max` instead of the browser learning them from a 400.
 *
 * This is the reported bug's fix on the API side: «поставив усі затримки на 0 — не зберігається, і
 * не сказано, яке поле і які межі». Every numeric field the PUT accepts appears here with a range —
 * four of them — so the console can render «мін … макс» beside each input and can refuse locally
 * before a round trip. `publicationDelaySeconds` is deliberately NOT a range: it is a deployment
 * constant from `.env`, shown so the form can say what `delayed_15s` will actually cost.
 *
 * The four ranges are re-exported from `runtime-settings.ts` rather than restated, because a second
 * copy of a CHECK constraint is a copy that drifts.
 */
const BOUNDS = {
  ...RUNTIME_SETTINGS_BOUNDS,
  publicationDelaySeconds: config.PUBLICATION_DELAY_SECONDS
} as const;

/**
 * What the hold is actually doing right now, as opposed to what is stored.
 *
 * `backlogEvents` is the number this card exists for — «скільки подій уже записано, але ще не
 * опубліковано». In `live` mode it is zero except for rows written in the same millisecond as the
 * read. A stored switch without this block is the confusing state the whole endpoint was designed to
 * avoid: a mode label with nothing to say whether it is taking effect.
 */
function effectiveOf(slice: PublicationSlice, now: Date) {
  return {
    delaySeconds: slice.delaySeconds,
    cutoffAt: slice.cutoffAt.toISOString(),
    cutoffVersion: slice.cutoffVersion,
    lastPublishedEventAt: slice.lastPublishedEventAt?.toISOString() ?? null,
    backlogEvents: slice.headVersion - slice.cutoffVersion,
    behindSeconds: sliceMeta(slice, now).behindSeconds
  };
}

/**
 * PUT, not PATCH, because the console sends the whole form — but the body is validated as a patch so
 * a `curl` that only wants to flip the mode does not have to restate four numbers it does not care
 * about. `.strict()` because a typo'd key ("publicationModes") silently doing nothing is the failure
 * mode an operator discovers by watching the map not change.
 */
const bounded = (field: keyof typeof RUNTIME_SETTINGS_BOUNDS) => {
  const { min, max } = RUNTIME_SETTINGS_BOUNDS[field];
  return z.coerce.number().int().min(min).max(max).optional();
};

const runtimeSettingsBody = z.object({
  publicationMode: z.enum(PUBLICATION_MODES).optional(),
  analyticsEventDriven: z.boolean().optional(),
  analyticsDebounceMs: bounded('analyticsDebounceMs'),
  analyticsMaxDelayMs: bounded('analyticsMaxDelayMs'),
  analyticsMinPassIntervalMs: bounded('analyticsMinPassIntervalMs'),
  codexCooldownMs: bounded('codexCooldownMs')
}).strict();

/**
 * Operator control over publication timing and the recompute cadence.
 *
 * A separate plugin, registered without `fastify-plugin`, for the reason the rest of `/ops` is: the
 * auth guard belongs to these routes and has no business leaking onto every response the server
 * sends. Every path starts with `/ops/` including the slash — `setNotFoundHandler` in `server.ts`
 * JSON-404s only `/api/`, `/health/` and `/ops/`, so a route registered as `/ops-runtime` would be
 * answered with `index.html` and a 200.
 */
const opsRuntimeRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Everything the form needs in one request: the stored values, the bounds they are checked
   * against, the trail of who changed what, and the sentence that says what the delay does not
   * touch. A switch set to on beside a dead session is the single most confusing state an ops page
   * can be in, and a second round trip is how that state happens.
   *
   * The row is read DIRECTLY, not through the memo: an operator refreshing the console must see what
   * is stored, not what a two-second cache remembers.
   */
  app.get('/ops/api/runtime', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    const [settings, audit, slice] = await Promise.all([
      readRuntimeSettings(), readRuntimeSettingsAudit(20), publicationSlice()
    ]);
    return { settings, effective: effectiveOf(slice, new Date()), bounds: BOUNDS, audit, notice: NOTICE };
  });

  app.put('/ops/api/runtime', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    const parsed = runtimeSettingsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_settings', issues: parsed.error.issues.map((issue) => issue.path.join('.'))
      });
    }
    // FAST PATH ONLY. Checked against the resolved values rather than the patch, so a request that
    // lowers only the max delay is rejected against the debounce already stored — but this read is
    // outside the FOR UPDATE that actually applies the patch, so two concurrent requests can both
    // pass it. The authoritative check is inside `saveRuntimeSettings` and arrives here as
    // RuntimeSettingsRangeError; without that second check the pair reaches the operator as the 500
    // this branch exists to prevent, with no `issues` array to act on.
    const current = await readRuntimeSettings();
    const next = applyRuntimeSettingsPatch(current, parsed.data);
    try {
      validateRuntimeSettings(next);
    } catch (error) {
      if (error instanceof RuntimeSettingsRangeError) {
        return reply.code(400).send({ error: 'invalid_settings', issues: [error.field] });
      }
      throw error;
    }
    let settings;
    try {
      ({ settings } = await saveRuntimeSettings(parsed.data, config.OPS_USER));
    } catch (error) {
      if (error instanceof RuntimeSettingsRangeError) {
        return reply.code(400).send({ error: 'invalid_settings', issues: [error.field] });
      }
      throw error;
    }
    // The same shape as GET, `effective` included: the console re-renders from this response, and a
    // form that showed the new mode beside the previous slice would be the "switch on beside a dead
    // session" state this endpoint exists to prevent. `saveRuntimeSettings` primes the settings
    // memo, so the slice below already reads the mode that was just written.
    const [audit, slice] = await Promise.all([readRuntimeSettingsAudit(20), publicationSlice()]);
    return { settings, effective: effectiveOf(slice, new Date()), bounds: BOUNDS, audit, notice: NOTICE };
  });
};

export default opsRuntimeRoutes;
export { opsRuntimeRoutes };
