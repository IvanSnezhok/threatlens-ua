-- 055 — дві моделі Codex і актуалізація треку загрози.
--
-- ================================================================================================
-- Чому друга модель
-- ================================================================================================
--
-- Досі в `codex_settings` була одна модель на все: і на повільні поверхні (наратив, дайджест,
-- статистику ударів, дослідження, тактику, ризик), і на гарячий шлях, де повідомлення чекає на
-- вердикт, перш ніж потрапити на карту (основний класифікатор, тінь, ретроспективний гейт, переказ
-- руху). Замір 23.09.2026 з чергою `priority`/`default`: gpt-6-luna відповідає на пінг за 1,2–1,7 с,
-- gpt-5.6-luna — за 1,2–6,7 с. Для гарячого шляху хвіст у шість секунд — це попередження, яке
-- приходить пізніше, ніж могло, тож гарячим поверхням потрібна своя, швидша модель, а важким —
-- лишити їхню.
--
-- `fast_model` NULL означає «як основна»: інсталяція, що оновилася в цю міграцію, кличе ту саму
-- модель, що й до неї, доки оператор не обере іншу в /ops.
--
-- ================================================================================================
-- Чому `flex` більше не допускається
-- ================================================================================================
--
-- З 20.08.2026 КОЖЕН виклик Codex відповідав 400: у рядку налаштувань стояла черга `flex`, і бекенд
-- відповідав `{"detail":"Unsupported service_tier: flex"}` — виміряно й для gpt-5.6-luna, і для
-- gpt-6-luna, тоді як `default` і `priority` проходять. Тіло відповіді клієнт відкидав, тож в
-- `ai_runs` місяць стояло лише «Codex відповів 400», а режим `classifier_mode=codex` мовчки віддавав
-- кожне повідомлення правилам. Значення, яке бекенд гарантовано відкидає, не має бути вибором у
-- консолі: рядок переводиться на `priority` (fast-режим Codex CLI, те саме замовчування, що в 047), і
-- CHECK більше не пускає `flex` назад.
--
-- ================================================================================================
-- Актуалізація треку
-- ================================================================================================
--
-- Швидка модель перечитує останні повідомлення живої події й каже, де ціль ЗАРАЗ, чи кружляє вона,
-- минула чи зникла і з якого повідомлення починається поточний відрізок треку — усе раніше стає
-- історією. Рядок — лише ПІДКАЗКА для намальованого треку (`src/services/track-actualization.ts`):
--
--   * він не створює, не завершує й не зливає подій, не торкається тривог і ніколи не є відбоєм;
--   * кожне місце в ньому — лише ті id, що їх названі повідомлення події вже мали (FK на `locations`
--     тримає ідентифікатор чесним, а код — належність до вхідних повідомлень);
--   * на публічну карту він потрапляє лише в режимі `classifier_mode='codex'`, з увімкненим
--     `actualization_enabled`, з упевненістю від 0,6 і лише якщо бачив найновішу класифікацію події.
--     Будь-який інший випадок і будь-який збій — детермінований трек, тож вектор ніколи не залежить
--     від моделі.
--
-- `input_digest` — sha256 того, що модель прочитала (без поточного часу): те саме введення не
-- записується двічі. Рядки старші за сім діб прибирає тік обслуговування (`src/services/operations.ts`).

ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS fast_model text NULL,
  ADD COLUMN IF NOT EXISTS actualization_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN codex_settings.fast_model IS
  'Швидка модель для гарячих поверхонь (класифікатор, тінь, ретроспективний гейт, переказ руху, актуалізація треку). NULL — як основна модель.';
COMMENT ON COLUMN codex_settings.actualization_enabled IS
  'Актуалізація треку загрози швидкою моделлю. Лише підказка для намальованого треку; вимкнено за замовчуванням.';

-- Спершу рядок, потім обмеження: новий CHECK перевіряє наявні рядки, і `flex`, що лишився б, зупинив
-- би міграцію.
UPDATE codex_settings SET service_tier='priority' WHERE service_tier='flex';

ALTER TABLE codex_settings DROP CONSTRAINT IF EXISTS codex_settings_service_tier_check;
ALTER TABLE codex_settings ADD CONSTRAINT codex_settings_service_tier_check
  CHECK (service_tier IN ('priority','default'));

COMMENT ON COLUMN codex_settings.service_tier IS
  'Черга обслуговування: priority (fast-режим Codex CLI) | default. flex бекенд відхиляє з 400 (міграція 055).';

CREATE TABLE IF NOT EXISTS threat_track_actualizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES threat_events(id) ON DELETE CASCADE,
  as_of timestamptz NOT NULL,            -- max published_at of classifications the model saw
  created_at timestamptz NOT NULL DEFAULT now(),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('moving','loitering','passed','ended','unclear')),
  head_location_id text NULL REFERENCES locations(id),
  heading_location_id text NULL REFERENCES locations(id),
  origin_location_id text NULL REFERENCES locations(id),
  loiter_location_id text NULL REFERENCES locations(id),
  current_since timestamptz NULL,        -- classifications published before this are history
  summary text NULL CHECK (summary IS NULL OR char_length(summary) <= 200),
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  input_digest text NOT NULL,
  UNIQUE (event_id, input_digest)
);

-- Обидва читання — «найновіший рядок події» для карти й «останній as_of» для вибору кандидатів
-- воркером — ідуть рівно цим індексом.
CREATE INDEX IF NOT EXISTS threat_track_actualizations_event_idx
  ON threat_track_actualizations (event_id, created_at DESC);

COMMENT ON TABLE threat_track_actualizations IS
  'Модельна підказка до намальованого треку загрози: де ціль зараз, куди прямує, чи кружляє. Не створює й не завершує подій, не торкається тривог; застосовується лише в режимі codex.';
