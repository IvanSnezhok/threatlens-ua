-- Швидкість виклику моделі: глибина міркування й черга обслуговування.
--
-- Досі в `codex_settings` була сама модель, і тіло запиту до `/responses` містило рівно `model`.
-- Бекенд приймає ще два поля, які визначають не ЩО він відповість, а ЯК довго думатиме й скільки
-- чекатиме в черзі:
--
--   reasoning.effort — low | medium | high | xhigh | max, вкладене поле;
--   service_tier     — поле ВЕРХНЬОГО рівня; 'priority' і є тим, що Codex CLI зве fast-режимом,
--                      'flex' — навпаки, дешевша й повільніша черга.
--
-- Обидва потрібні тут, а не в змінних середовища, з тієї самої причини, що й сама модель: оператор
-- міняє їх у `/ops` під час події, а не перезапуском контейнера.
--
-- ЧОМУ САМЕ MEDIUM І PRIORITY ЗА ЗАМОВЧУВАННЯМ. Узагальнення руху загроз — це переказ уже зібраних
-- фактів, а не аналіз: модель не має нічого виводити, вона має стисло переповісти те, що написали
-- канали, і назвати їх. Для цього `high` купує секунди затримки без виграшу в якості, а `low` уже
-- починає губити джерела. `priority` тут важливіший за глибину: повідомлення, яке приходить після
-- того, як загроза минула, не варте нічого, хоч би як добре було написане.
--
-- Обмеження на значення живе в CHECK, а не лише в коді: помилка в цьому полі виявилася б не при
-- збереженні, а при першому виклику моделі — тобто під час події.

ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS reasoning_effort text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS service_tier text NOT NULL DEFAULT 'priority';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codex_settings_reasoning_effort_check') THEN
    ALTER TABLE codex_settings ADD CONSTRAINT codex_settings_reasoning_effort_check
      CHECK (reasoning_effort IN ('low','medium','high','xhigh','max'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codex_settings_service_tier_check') THEN
    ALTER TABLE codex_settings ADD CONSTRAINT codex_settings_service_tier_check
      CHECK (service_tier IN ('priority','default','flex'));
  END IF;
END $$;

COMMENT ON COLUMN codex_settings.reasoning_effort IS
  'Глибина міркування моделі: low|medium|high|xhigh|max. Їде як reasoning.effort у тілі /responses.';
COMMENT ON COLUMN codex_settings.service_tier IS
  'Черга обслуговування: priority (fast-режим Codex CLI) | default | flex. Поле верхнього рівня.';

-- Переказ руху загрози з кількох каналів у сповіщення передплатникам.
--
-- Вимкнено за замовчуванням, як і кожен модельний перемикач у цій таблиці. `CONTEXT.md` дозволяє
-- ШІ узагальнювати, і саме узагальненням це й є — переказом уже зібраних повідомлень, без права
-- створити подію, змінити її стан чи торкнутися офіційної тривоги. Джерела в тексті обов'язкові:
-- абзац без назви каналу неперевірний, і такий відхиляється цілком (src/services/movement-summary.ts).
ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS movement_summary_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN codex_settings.movement_summary_enabled IS
  'Модельний переказ руху загрози в сповіщеннях. Джерела обов''язкові, інакше текст відхиляється.';
