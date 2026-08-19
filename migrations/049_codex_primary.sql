-- Codex як основний аналітик: режим класифікатора, актуальність і ймовірність загрози, контексти по
-- локаціях, модельна оцінка ризику.
--
-- ================================================================================================
-- Що змінюється і чому це рішення власника, а не дрейф
-- ================================================================================================
--
-- Досі модель у цьому проєкті стояла ПОЗАДУ правил: тіньовий класифікатор записував другу думку,
-- промоція (040) могла заповнити прогалину неперевіреною подією, збагачення (045) — дописати примітку,
-- яку ніхто не читає. 18.08.2026 власник вирішив інакше: основним аналітиком має стати Codex — він
-- класифікує повідомлення, визначає, КОЛИ загроза актуальна (зараз, протягом години, увечері,
-- протягом доби, протягом двох діб) і з якою ймовірністю, пише аналітику, і для кожного запиту має
-- контекст по області, місту чи населеному пункту, стиснутий моделлю, щойно переросте сто тисяч
-- токенів. Детерміновані правила лишаються ЗАПАСНИМ шляхом: коли модель недоступна, повільна, поза
-- бюджетом або відповіла непридатним — повідомлення класифікують правила, як і раніше.
--
-- Що НЕ змінюється, бо це межі CONTEXT.md, а не налаштування:
--
--   * офіційні тривоги — лише з офіційного API; жоден шлях звідси не пише в `alert_*`;
--   * відбій загрози (withdrawal) і далі походить лише від правил: модель може стверджувати й
--     уточнювати, але не може оголосити, що загрози більше немає;
--   * усе вимкнено за замовчуванням: `classifier_mode` = 'rules', `risk_enabled` = false. Інсталяція,
--     яка оновилася в цю міграцію, поводиться точно як до неї, доки оператор не перемкне режим.

-- ------------------------------------------------------------------------------------------------
-- 1. Режим класифікатора й модельна оцінка ризику — в тій самій таблиці перемикачів
-- ------------------------------------------------------------------------------------------------
ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS classifier_mode text NOT NULL DEFAULT 'rules',
  ADD COLUMN IF NOT EXISTS risk_enabled boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codex_settings_classifier_mode_check') THEN
    ALTER TABLE codex_settings ADD CONSTRAINT codex_settings_classifier_mode_check
      CHECK (classifier_mode IN ('rules','codex'));
  END IF;
END $$;

COMMENT ON COLUMN codex_settings.classifier_mode IS
  'rules — детерміновані правила класифікують, модель лише тіньова; codex — модель класифікує кожне повідомлення (актуальність, ймовірність, локації), правила — запасний шлях і єдине джерело відбоїв.';
COMMENT ON COLUMN codex_settings.risk_enabled IS
  'Оцінка ризику по локаціях моделлю Codex (замість AI_* або правил) з контекстом локації. Вимкнено за замовчуванням.';

-- ------------------------------------------------------------------------------------------------
-- 2. Актуальність і ймовірність на події
-- ------------------------------------------------------------------------------------------------
--
-- `timing` — коли, за словами джерела, загроза стосується названих місць. DEFAULT 'now' робить
-- міграцію невидимою для всього, що є: кожна подія, написана правилами, — про «зараз», як і раніше.
-- `probability` — оцінка моделі, що загроза реалізується для названих місць у своєму вікні; NULL для
-- подій правил. `expected_from`/`expected_until` — вікно актуальності; для 'now' збігається з
-- [last_observed_at, valid_until]. `classified_by` — хто збудував класифікацію: правила чи модель.
-- Це інша вісь, ніж `origin` (041): `origin='model'` — промоція, тобто модельний здогад ПОНАД тим, що
-- сказало джерело; `classified_by='codex'` — модель прочитала повідомлення джерела й виклала, що в ньому
-- сказано, тож твердження лишається твердженням джерела, з доказовістю джерела.
ALTER TABLE threat_events
  ADD COLUMN IF NOT EXISTS timing text NOT NULL DEFAULT 'now',
  ADD COLUMN IF NOT EXISTS probability numeric(4,3),
  ADD COLUMN IF NOT EXISTS expected_from timestamptz,
  ADD COLUMN IF NOT EXISTS expected_until timestamptz,
  ADD COLUMN IF NOT EXISTS classified_by text NOT NULL DEFAULT 'rules',
  ADD COLUMN IF NOT EXISTS assessment_note text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'threat_events_timing_check') THEN
    ALTER TABLE threat_events ADD CONSTRAINT threat_events_timing_check
      CHECK (timing IN ('now','within_hour','evening','within_day','within_two_days'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'threat_events_probability_check') THEN
    ALTER TABLE threat_events ADD CONSTRAINT threat_events_probability_check
      CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'threat_events_classified_by_check') THEN
    ALTER TABLE threat_events ADD CONSTRAINT threat_events_classified_by_check
      CHECK (classified_by IN ('rules','codex'));
  END IF;
END $$;

COMMENT ON COLUMN threat_events.timing IS
  'Коли загроза актуальна за словами джерела: now | within_hour | evening | within_day | within_two_days. Подія правил — завжди now.';
COMMENT ON COLUMN threat_events.probability IS
  'Оцінка моделі (0..1), що загроза реалізується для названих місць у своєму вікні. NULL — правила не оцінюють ймовірності.';
COMMENT ON COLUMN threat_events.classified_by IS
  'rules — класифікацію збудували правила; codex — модель у режимі classifier_mode=codex. Інша вісь, ніж origin.';

-- Очікувані події живуть довше за тридцять хвилин і їх читають за вікном, а не за останньою згадкою.
CREATE INDEX IF NOT EXISTS threat_events_expected_idx
  ON threat_events (expected_until) WHERE timing <> 'now';

COMMENT ON COLUMN threat_events.origin IS
  'Чиє це твердження: deterministic — твердження джерела (прочитане правилами або, за classified_by=codex, моделлю); model — промоція, модельний здогад понад тим, що сказало джерело';

-- ------------------------------------------------------------------------------------------------
-- 3. Те саме в архіві класифікацій — щоб рішення моделі можна було міряти так само, як рішення правил
-- ------------------------------------------------------------------------------------------------
ALTER TABLE message_classifications
  ADD COLUMN IF NOT EXISTS timing text,
  ADD COLUMN IF NOT EXISTS probability numeric(4,3),
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS model_confidence numeric(4,3),
  ADD COLUMN IF NOT EXISTS model_note text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_classifications_timing_check') THEN
    ALTER TABLE message_classifications ADD CONSTRAINT message_classifications_timing_check
      CHECK (timing IS NULL OR timing IN ('now','within_hour','evening','within_day','within_two_days'));
  END IF;
END $$;

COMMENT ON COLUMN message_classifications.model IS
  'Модель, яка збудувала цю класифікацію (classifier_version codex-primary-*). NULL — правила.';

-- ------------------------------------------------------------------------------------------------
-- 4. Контекст по локації для кожного запиту до моделі
-- ------------------------------------------------------------------------------------------------
--
-- Один рядок на локацію (область, район, місто, «ua» для національного масштабу): хронологічний
-- текст — що повідомляли про це місце, що вирішила модель або правила, коли починалися й закінчувалися
-- офіційні тривоги. Він їде в кожен запит моделі, що стосується цієї локації (класифікація, оцінка
-- ризику), у межах бюджету токенів запиту. Коли оцінка розміру переростає MODEL_CONTEXT_MAX_TOKENS
-- (типово 100 000), модель просять стиснути: лишити свіже детально, старе — стисло, неактуальне —
-- викинути. `estimated_tokens` — оцінка без токенізатора (src/domain/token-estimate.ts), свідомо
-- завищена, тож стискання настає раніше, а не пізніше.
CREATE TABLE IF NOT EXISTS model_location_contexts (
  location_id text PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  estimated_tokens integer NOT NULL DEFAULT 0 CHECK (estimated_tokens >= 0),
  entries integer NOT NULL DEFAULT 0 CHECK (entries >= 0),
  compactions integer NOT NULL DEFAULT 0 CHECK (compactions >= 0),
  compacted_at timestamptz,
  compacting_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_location_contexts_updated_idx ON model_location_contexts (updated_at DESC);

COMMENT ON TABLE model_location_contexts IS
  'Хронологічний контекст по локації для запитів до моделі; стискається моделлю, щойно переросте стелю токенів.';
