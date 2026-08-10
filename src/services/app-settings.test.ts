import { afterEach, describe, expect, it } from 'vitest';
import { APP_SETTINGS, type AppConfig, config, parseAppConfig } from '../config.js';
import {
  DEFAULT_CONFIG,
  auditChange,
  candidateEnv,
  envString,
  isSecretSetting,
  isWritableSetting,
  parseWithDegrade,
  pendingRestartKeys,
  resetAppSettingsCache
} from './app-settings.js';

/**
 * The pure half of the settings resolution, with no database anywhere near it.
 *
 * Everything under test here is a function of two plain objects — the environment and the store —
 * which is the whole reason `candidateEnv` and `parseWithDegrade` were separated from the read that
 * feeds them. The transaction, the audit rows and the wire shape are covered end to end in
 * `tests/integration/ops-settings.test.ts`; what cannot be covered there is the case that must never
 * reach a database at all, which is a stored `OPS_PASSWORD`.
 */

/** A minimal environment: nothing set, so every key falls to its schema default. */
const BARE: Record<string, string | undefined> = {};

afterEach(() => {
  // `pendingRestartKeys` reads the live `config`, and one test moves it.
  resetAppSettingsCache();
});

describe('candidateEnv', () => {
  it('lays writable rows over the environment and leaves everything else exactly as it was', () => {
    const base = { AI_TIMEOUT_MS: '9000', MAP_STYLE_URL: 'https://tiles.example/env', PATH: '/usr/bin' };
    const candidate = candidateEnv(base, { AI_TIMEOUT_MS: '31000', KATOTTG_VERSION: '01.01.2027' });

    expect(candidate.AI_TIMEOUT_MS).toBe('31000');       // stored wins over the environment
    expect(candidate.KATOTTG_VERSION).toBe('01.01.2027'); // stored fills a gap
    expect(candidate.MAP_STYLE_URL).toBe('https://tiles.example/env'); // untouched by the store
    expect(candidate.PATH).toBe('/usr/bin');             // the rest of the environment is a base, not a filter
    // The base is not mutated: `loadAppSettings` hands it `process.env`.
    expect(base.AI_TIMEOUT_MS).toBe('9000');
  });

  /**
   * Gate 1 of the two, and the reason this file exists.
   *
   * A row named `OPS_PASSWORD` can arrive from a hand-edited table or a restored dump, and the write
   * API refusing to CREATE one says nothing about one that is already there. The overlay is where it
   * has to die, because the overlay runs at every boot.
   */
  it('refuses an env-scoped row and an orphan row, and reports neither by changing the overlay', () => {
    const base = { OPS_PASSWORD: 'the-real-one', PORT: '3000' };
    const candidate = candidateEnv(base, {
      OPS_PASSWORD: 'chosen-from-the-web-page',
      DEPLOY_RUNNER_URL: 'http://attacker:9000',
      PORT: '9999',
      SOME_KEY_FROM_AN_OLDER_IMAGE: 'x'
    });

    expect(candidate.OPS_PASSWORD).toBe('the-real-one');
    expect(candidate.DEPLOY_RUNNER_URL).toBeUndefined();
    expect(candidate.PORT).toBe('3000');
    expect(candidate.SOME_KEY_FROM_AN_OLDER_IMAGE).toBeUndefined();
    // And the classification the gate reads, stated directly.
    expect(isWritableSetting('OPS_PASSWORD')).toBe(false);
    expect(isWritableSetting('SOME_KEY_FROM_AN_OLDER_IMAGE')).toBe(false);
    expect(isWritableSetting('AI_TIMEOUT_MS')).toBe(true);
  });
});

describe('parseWithDegrade', () => {
  it('parses a legal overlay whole, rejecting nothing', () => {
    const result = parseWithDegrade(BARE, { AI_TIMEOUT_MS: '31000', ANALYTICS_NARRATIVE_ENABLED: 'true' });

    expect(result.rejected).toEqual([]);
    expect(result.config.AI_TIMEOUT_MS).toBe(31000);
    expect(result.config.ANALYTICS_NARRATIVE_ENABLED).toBe(true);
  });

  /**
   * The per-key failure direction. One bad row must cost one setting, never the other seventy-nine
   * and never the boot — a container that will not start because a convenience table holds a typo is
   * the outage this whole module is written to avoid.
   */
  it('drops exactly the key the schema blamed and lets the environment stand for it', () => {
    const base = { AI_TIMEOUT_MS: '9000' };
    const result = parseWithDegrade(base, {
      AI_TIMEOUT_MS: 'тридцять секунд',
      RETROSPECTIVE_GATE_TIMEOUT_MS: '5',            // below the 250 ms floor
      MAP_STYLE_URL: 'https://tiles.example/stored'  // legal, and must survive its neighbours
    });

    expect(result.rejected.sort()).toEqual(['AI_TIMEOUT_MS', 'RETROSPECTIVE_GATE_TIMEOUT_MS']);
    expect(result.config.AI_TIMEOUT_MS).toBe(9000);                       // back to the environment
    expect(result.config.RETROSPECTIVE_GATE_TIMEOUT_MS).toBe(2500);       // back to the default
    expect(result.config.MAP_STYLE_URL).toBe('https://tiles.example/stored');
  });

  /**
   * When the blame lands on something the store does not contain, the environment itself is
   * unparseable and degrading is not this function's business — the environment IS the fallback.
   *
   * Every cross-field refinement in `src/config.ts` names an `env`-scoped key, which is why this is
   * currently unreachable from a stored row; the behaviour is pinned so it stays that way if one is
   * ever added.
   */
  it('re-throws rather than degrading when no stored key is to blame', () => {
    const base = {
      NODE_ENV: 'production', OPS_PASSWORD: 'too-short', METRICS_TOKEN: 'also-short',
      PUBLIC_URL: 'http://not-https.example', DATABASE_URL: 'postgresql://threatlens:threatlens@db/x'
    };
    expect(() => parseWithDegrade(base, { AI_TIMEOUT_MS: '31000' })).toThrow();
  });
});

describe('the audit trail', () => {
  /**
   * The one place a credential could reach a table that is dumped nightly, and does not.
   *
   * Not «замінено» as a nicety: the previous token is exactly as sensitive as the new one, and an
   * audit row is the surface most likely to be pasted into a support thread.
   */
  it('records that a secret changed and never what it changed from or to', () => {
    const replaced = auditChange('TELEGRAM_BOT_TOKEN', '123456:OLD-TOKEN-VALUE', '654321:NEW-TOKEN-VALUE');
    expect(replaced).toEqual({
      field: 'TELEGRAM_BOT_TOKEN', previousValue: '«замінено»', newValue: '«замінено»'
    });

    const first = auditChange('AI_API_KEY', null, 'sk-live-0001');
    expect(first).toEqual({ field: 'AI_API_KEY', previousValue: null, newValue: '«замінено»' });

    const cleared = auditChange('CODEX_API_KEY', 'sk-live-0002', null);
    expect(cleared).toEqual({ field: 'CODEX_API_KEY', previousValue: '«замінено»', newValue: '«знято»' });

    // A non-secret writes what actually happened, which is what makes the trail readable at all.
    expect(auditChange('AI_TIMEOUT_MS', '20000', '31000'))
      .toEqual({ field: 'AI_TIMEOUT_MS', previousValue: '20000', newValue: '31000' });
    // …and a reset is a real event, so it is «знято» rather than a NULL a reader has to interpret.
    expect(auditChange('AI_TIMEOUT_MS', '31000', null))
      .toEqual({ field: 'AI_TIMEOUT_MS', previousValue: '31000', newValue: '«знято»' });
  });
});

describe('the restart banner', () => {
  /**
   * `pendingRestart` is a claim about a consumer, not about a value: it must appear when a key whose
   * consumer froze the value has moved, and must not appear for a key every consumer re-reads.
   */
  it('names a restart-mode key that moved, and nothing else', () => {
    expect(pendingRestartKeys()).toEqual([]);

    // TELEGRAM_MODE is read once, in createBot(); AI_TIMEOUT_MS is read per call.
    Object.assign(config, { TELEGRAM_MODE: 'disabled', AI_TIMEOUT_MS: 31000 });
    expect(pendingRestartKeys()).toEqual(['TELEGRAM_MODE']);

    resetAppSettingsCache();
    expect(pendingRestartKeys()).toEqual([]);
    // The seam is an inverse, not a clear: the boot values are back.
    expect(config.TELEGRAM_MODE).toBe(parseAppConfig(process.env).TELEGRAM_MODE);
    expect(config.AI_TIMEOUT_MS).toBe(parseAppConfig(process.env).AI_TIMEOUT_MS);
  });
});

describe('the registry', () => {
  /**
   * Two properties the settings page depends on and nothing else would notice breaking.
   *
   * The round trip is the sharper one: the page shows a «за замовчуванням» column, and it shows it
   * as an env-string produced by `envString`. If that string did not re-parse to the same value the
   * column would be a plausible-looking lie — and for the ten booleans it is exactly the sort of lie
   * that survives review, because `String(false)` and `'false'` look identical in a diff.
   */
  it('is internally consistent, and every default survives a round trip through envString', () => {
    const keys = Object.keys(APP_SETTINGS) as Array<keyof AppConfig>;

    for (const key of keys) {
      const meta = APP_SETTINGS[key];
      // An `env` key without a reason is a refusal the page cannot explain.
      if (meta.scope === 'env') expect(meta.envReason, key).toBeTruthy();
      else expect(meta.envReason, key).toBeUndefined();
      // Every credential is redacted by the same predicate the serialiser reads.
      if (meta.scope === 'db_secret') expect(isSecretSetting(key), key).toBe(true);
      // A `restart` key that cannot say why is a banner nobody can act on.
      if (meta.apply === 'restart' && meta.scope !== 'env') expect(meta.applyNote, key).toBeTruthy();
    }

    // The redacted set, pinned. Four of these are `env`-scoped: being unwritable is not the same as
    // being safe to print, and a new credential that forgot `kind: 'secret'` fails here.
    expect(keys.filter((key) => isSecretSetting(key)).sort()).toEqual([
      'AI_API_KEY', 'ALERTS_IN_UA_TOKEN', 'CODEX_ACCOUNT_ID', 'CODEX_API_KEY', 'DATABASE_URL',
      'DEPLOY_RUNNER_TOKEN', 'METRICS_TOKEN', 'OPS_PASSWORD', 'TELEGRAM_API_HASH', 'TELEGRAM_API_ID',
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_SESSION', 'UKRAINE_ALARM_API_TOKEN'
    ]);

    const asEnv = Object.fromEntries(keys.map((key) => [key, envString(DEFAULT_CONFIG[key])]));
    expect(parseAppConfig(asEnv)).toEqual(DEFAULT_CONFIG);
  });
});
