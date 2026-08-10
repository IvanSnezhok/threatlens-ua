import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_SETTINGS, SETTING_GROUPS, type AppConfig, type SettingMeta, config } from '../config.js';
import {
  AppSettingsUnknownKeyError,
  AppSettingsValidationError,
  DEFAULT_CONFIG,
  type AppSettingRow,
  appSettingsState,
  envString,
  isSecretSetting,
  isWritableSetting,
  parseWithDegrade,
  pendingRestartKeys,
  readAppSettingsAudit,
  readAppSettingsRows,
  saveAppSettings
} from '../services/app-settings.js';
import { readRuntimeSettings } from '../services/runtime-settings.js';
import { telegramCollectorStatus } from '../sources/telegram.js';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

/**
 * The sentence the settings page shows above the groups. It states the precedence, because
 * precedence is the one thing an operator has to hold in their head to read this page at all, and it
 * states what is never shown, because a page full of «••••» that did not say why would look broken.
 */
const NOTICE = 'Пріоритет значень: рядок у базі → змінна в .env → значення за замовчуванням. '
  + 'Зміна застосовується одразу, крім ключів, позначених «потребує перезапуску». '
  + 'Значення секретів не показуються й не повертаються цим API — лише те, чи вони встановлені.';

// ------------------------------------------------------------------------------------------------
// Serialisation
// ------------------------------------------------------------------------------------------------

interface SerialisedSetting {
  key: string;
  group: SettingMeta['group'];
  scope: SettingMeta['scope'];
  ui: SettingMeta['ui'];
  apply: SettingMeta['apply'];
  applyNote: string | null;
  confirm: boolean;
  impact: SettingMeta['impact'] | null;
  source: 'db' | 'env' | 'default';
  stored: string | null;
  applied: string | null;
  envValue: string | null;
  defaultValue: string | null;
  isSecret: boolean;
  isSet: boolean;
  pendingRestart: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface SerialiseContext {
  rows: Map<string, AppSettingRow>;
  rejected: Set<string>;
  restartPending: Set<string>;
  env: Record<string, string | undefined>;
}

/**
 * THE serialisation function. Every settings value that leaves this process leaves through here.
 *
 * That is not an aesthetic preference. `stored`, `applied`, `envValue` and `defaultValue` are four
 * different ways to say the same secret, and a second place that built any one of them is a second
 * place that would have to remember the rule. So there is one place, one `if`, and
 * `tests/integration/ops-settings.test.ts` searches the ENTIRE serialised response — every field of
 * every setting, the audit tail included — for the credential, rather than asserting on the four
 * fields somebody thought of.
 *
 * `isSet` survives the redaction and is the whole of what a secret publishes: whether a value is in
 * force at all. Together with `source` that answers the only two questions the console needs to draw
 * the field («•••• встановлено, з .env» / «не задано»), and neither can be inverted into the value.
 */
function serialiseSetting(key: string, meta: SettingMeta, context: SerialiseContext): SerialisedSetting {
  const row = context.rows.get(key);
  const stored = row && isWritableSetting(key) && !context.rejected.has(key) ? row.value : null;
  const envValue = context.env[key];
  const applied = envString(config[key as keyof AppConfig]);
  const secret = isSecretSetting(key);
  const source: SerialisedSetting['source'] = stored !== null ? 'db'
    : envValue !== undefined ? 'env' : 'default';
  return {
    key,
    group: meta.group,
    scope: meta.scope,
    ui: meta.ui,
    apply: meta.apply,
    applyNote: meta.applyNote ?? null,
    confirm: meta.confirm === true,
    impact: meta.impact ?? null,
    source,
    // The four value fields, and the one branch that decides whether any of them is a value.
    stored: secret ? null : row?.value ?? null,
    applied: secret ? null : applied,
    envValue: secret ? null : envValue ?? null,
    defaultValue: secret ? null : envString(DEFAULT_CONFIG[key as keyof AppConfig]),
    isSecret: secret,
    // «Is something in force», not «is there a row»: an operator looking at a token wants to know
    // whether the collector has a credential, and where it came from is the `source` field's job.
    isSet: applied !== '',
    pendingRestart: context.restartPending.has(key),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null
  };
}

/**
 * Everything the page needs in one request.
 *
 * The rows are re-read from the database rather than taken from the module's own state, for the
 * reason `GET /ops/api/runtime` gives: an operator refreshing the console must see what is STORED.
 * `applied` still comes from the live `config`, because that is what the process is actually running
 * — the pair is the honest answer, and they differ only if somebody edited the table by hand.
 *
 * `rejected` is recomputed here from those same fresh rows, purely, without applying anything: a GET
 * must not be able to change what the process is running.
 */
async function settingsPayload() {
  const [rows, audit, runtime] = await Promise.all([
    readAppSettingsRows(), readAppSettingsAudit(null, 20), readRuntimeSettings()
  ]);
  const store = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const { rejected } = parseWithDegrade(process.env, store);
  const restartPending = pendingRestartKeys();
  const context: SerialiseContext = {
    rows: new Map(rows.map((row) => [row.key, row])),
    rejected: new Set(rejected),
    restartPending: new Set(restartPending),
    env: process.env
  };
  const state = appSettingsState();
  return {
    groups: SETTING_GROUPS,
    settings: Object.entries(APP_SETTINGS).map(([key, meta]) => serialiseSetting(key, meta, context)),
    // The same thirty-odd refusals as `settings[].scope === 'env'`, extracted so the console can
    // render one «чому це лише в .env» list without walking the whole array.
    envOnly: Object.entries(APP_SETTINGS)
      .filter(([, meta]) => meta.scope === 'env')
      .map(([key, meta]) => ({ key, reason: meta.envReason ?? '' })),
    /** Rows for keys this image has never heard of: a rename, or a rollback to an older build. */
    orphans: rows.filter((row) => !(row.key in APP_SETTINGS)).map((row) => row.key),
    /** Rows for `env`-scoped keys. Only a hand-edited table produces one; gate 1 ignores them. */
    blocked: rows.filter((row) => row.key in APP_SETTINGS && !isWritableSetting(row.key)).map((row) => row.key),
    rejected,
    collector: telegramCollectorStatus(),
    restartPending: { count: restartPending.length, keys: restartPending },
    audit,
    // Additive, and the reason the read-failure counter is not the only way to notice: `true` means
    // the boot read failed outright and every value below is the environment's.
    degraded: state.degraded,
    publicationMode: runtime.publicationMode,
    notice: NOTICE
  };
}

// ------------------------------------------------------------------------------------------------
// The write
// ------------------------------------------------------------------------------------------------

/**
 * `.strict()`, and `values` is a plain string-or-null map rather than a per-key schema.
 *
 * There is deliberately NO zod schema for the settings themselves here. `parseAppConfig` is the
 * validator, it runs inside the transaction, and a per-key schema in the route would be a second
 * statement of the same bounds — the exact duplication `migrations/030_app_settings.sql` refuses to
 * put in SQL. This schema checks only the SHAPE of the request.
 */
const settingsBody = z.object({
  values: z.record(z.string(), z.union([z.string(), z.null()])),
  confirm: z.array(z.string()).optional()
}).strict();

/**
 * Operator control over `src/config.ts`.
 *
 * A separate plugin registered without `fastify-plugin`, like the rest of `/ops`: the auth guard
 * belongs to these routes and has no business leaking onto every response the server sends. Every
 * path starts with `/ops/` including the slash, or `setNotFoundHandler` in `server.ts` would answer
 * it with `index.html` and a 200.
 */
const opsSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/api/settings', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    return settingsPayload();
  });

  app.put('/ops/api/settings', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_settings', issues: parsed.error.issues.map((issue) => issue.path.join('.'))
      });
    }
    const values = parsed.data.values;
    const confirmed = new Set(parsed.data.confirm ?? []);

    // Unknown and `env`-scoped are ONE refusal on purpose. Telling an unauthenticated-by-obscurity
    // caller which of the two a key is would turn this endpoint into a probe for the schema; the
    // console already knows, because `envOnly` told it.
    const unknown = Object.keys(values).filter((key) => !isWritableSetting(key));
    if (unknown.length) return reply.code(400).send({ error: 'unknown_setting', keys: unknown });

    // Confirmation is demanded only for a key whose value actually MOVES. «Зберегти всі» re-sends
    // every field in a group, and demanding a second press for the four that did not change would
    // train the operator to confirm reflexively — which is the failure the confirmation exists to
    // prevent. The comparison is against this process's own state; it is the only writer.
    const stored = appSettingsState().store;
    const needsConfirmation = Object.entries(values)
      .filter(([key, value]) => APP_SETTINGS[key as keyof AppConfig].confirm === true
        && value !== (stored[key] ?? null) && !confirmed.has(key))
      .map(([key]) => key);
    if (needsConfirmation.length) {
      return reply.code(400).send({ error: 'confirmation_required', keys: needsConfirmation });
    }

    /**
     * The retraction hatch, closed.
     *
     * The publication cutoff is `GREATEST(now() - delay, mode_changed_at)`. Raising `delay` while
     * `delayed_15s` is in force moves that cutoff BACKWARDS, and rows already on the public map —
     * an active air-raid alert among them — would be withdrawn from it. Retracting a published alert
     * is the one thing this system may never do (`docs/ARCHITECTURE.md` §Consistency rules), and
     * migration 022 added `mode_changed_at` for precisely this failure on the mode flip.
     *
     * `live` is the only mode in which the hold is zero and there is nothing to retract, so that is
     * the only mode in which this value may be edited. Switch to `live` on the runtime card first;
     * the refusal names the condition rather than the field, because the field is not the problem.
     */
    if ('PUBLICATION_DELAY_SECONDS' in values) {
      const mode = (await readRuntimeSettings()).publicationMode;
      if (mode !== 'live') {
        return reply.code(409).send({ error: 'publication_delayed', publicationMode: mode });
      }
    }

    try {
      await saveAppSettings(values, config.OPS_USER);
    } catch (error) {
      // Gate 2 again, from inside the service: the route's own check above cannot see a key that
      // stopped being writable between the two, and the service refuses before it issues a
      // statement either way.
      if (error instanceof AppSettingsUnknownKeyError) {
        return reply.code(400).send({ error: 'unknown_setting', keys: error.keys });
      }
      if (error instanceof AppSettingsValidationError) {
        return reply.code(400).send({ error: 'invalid_settings', issues: error.issues });
      }
      throw error;
    }
    // The same shape as GET: the console re-renders from this response, and a second round trip to
    // learn what it just wrote is a round trip in which the two can disagree.
    return settingsPayload();
  });

  /**
   * One key's history. The composite index on `(field, changed_at DESC)` exists to answer this
   * without walking the whole trail.
   */
  app.get<{ Querystring: { key?: string; limit?: string } }>(
    '/ops/api/settings/audit',
    async (request, reply) => {
      if (!authorised(request)) return opsUnauthorized(request, reply);
      const key = request.query.key ?? null;
      if (key !== null && !(key in APP_SETTINGS)) {
        return reply.code(400).send({ error: 'unknown_setting', keys: [key] });
      }
      const limit = request.query.limit == null ? 50 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return reply.code(400).send({ error: 'invalid_limit' });
      }
      return { key, audit: await readAppSettingsAudit(key, limit) };
    }
  );
};

export default opsSettingsRoutes;
export { opsSettingsRoutes };
