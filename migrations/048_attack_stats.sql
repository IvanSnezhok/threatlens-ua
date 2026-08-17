-- Статистика ударів і ймовірнісний прогноз по регіону: перша `calculated`-поверхня, яку публікують.
--
-- ================================================================================================
-- Що це і чому воно існує
-- ================================================================================================
--
-- До цієї міграції проєкт мав два `calculated`-сімейства — екстраполяцію вектора (016) і
-- дослідження області (035) — і обидва живуть в `ops_`-таблицях саме тому, що «розрахунок про
-- майбутнє не публікується, ніколи». Це рішення власника змінює межу свідомо й вузько, 18.08.2026:
-- на публічній сторінці аналізу атак і в нічній аналітичній розсилці бота з'являється блок
-- **статистики ударів по обраних користувачем регіонах із пуассонівським прогнозом** — рівно у формі,
-- яку власник описав як задачу для моделі («OSINT-аналітик… побудуй ймовірнісний прогноз»).
--
-- Чим це відрізняється від того, що заборонено досі, і чому межа лишається межею:
--
--   * Це не прогноз цілі, маршруту чи часу удару. Це базова частота — «як часто цей регіон
--     атакували за період» — і виведена з неї ймовірність, що ДЕНЬ буде днем атаки. Модель ніде не
--     каже, куди прилетить.
--   * Числа приходять із ВІДКРИТИХ ДЖЕРЕЛ через вебпошук моделі (офіційні зведення, провідні медіа),
--     а не з нашого архіву повідомлень, і саме тому вони не змішуються з жодним публічним агрегатом:
--     блок читає ТІЛЬКИ ці таблиці, а ці таблиці ніхто, крім нього, не читає.
--   * Пуассонівська арифметика перераховується детерміновано з інтервалів, які назвала модель
--     (`src/domain/attack-stats-report.ts`): якщо її ймовірності не сходяться з її ж інтервалами,
--     звіт позначається `inconsistent` і читач бачить обидва числа.
--   * Дисклеймер їде першим рядком у боті й помітним блоком на сторінці, а сам звіт ні на що не
--     впливає: жодного шляху запису в тривоги, події, оцінки ризику, стан карти чи сповіщення про
--     загрози звідси немає — словник сервісу це SELECT/INSERT/UPDATE над двома таблицями нижче.
--
-- Дев'ятий перемикач Codex, вимкнений за замовчуванням, як і всі: інсталяція, яка оновилася в цю
-- міграцію, не почне раптом викликати модель і не покаже жодної ймовірності, доки оператор не
-- ввімкне «Статистика ударів і ймовірності» в /ops.

ALTER TABLE codex_settings
  ADD COLUMN IF NOT EXISTS attack_stats_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN codex_settings.attack_stats_enabled IS
  'Статистика ударів і пуассонівський прогноз по регіонах — модель із вебпошуком, без таймауту. Публічна сторінка атак і нічна аналітика бота. Вимкнено за замовчуванням.';

-- ================================================================================================
-- Інтерес: які регіони обрали користувачі
-- ================================================================================================
--
-- Публічний користувач НЕ запускає модель напряму. Вибір області на сторінці записує сюди один
-- рядок (upsert), а вже планувальник і воркер вирішують, коли й у якому порядку рахувати —
-- обмежено денним лімітом і одним запуском водночас. Таблиця обмежена зверху кількістю регіонів
-- (24 області + Київ), тож вона не може рости від кількості читачів.
CREATE TABLE IF NOT EXISTS attack_stats_interest (
  region_id text PRIMARY KEY REFERENCES locations(id),
  first_selected_at timestamptz NOT NULL DEFAULT now(),
  last_selected_at timestamptz NOT NULL DEFAULT now(),
  selections bigint NOT NULL DEFAULT 1 CHECK (selections >= 0)
);

-- ================================================================================================
-- Звіт: черга і результат в одному рядку
-- ================================================================================================
--
-- `queued` → `running` → `completed` | `failed`. Один активний рядок на регіон (частковий унікальний
-- індекс нижче) — це і є дедуплікація черги: другий запит на той самий регіон не створює другого
-- запуску, а повертає стан першого. Відмови (вимкнений перемикач, вичерпаний ліміт) рядків не
-- пишуть — вони рахуються метрикою, а не таблицею, бо тут, на відміну від 035, ліміт рахується не з
-- натискань, а з ПОСТАВЛЕНИХ У ЧЕРГУ звітів за київську добу.
CREATE TABLE IF NOT EXISTS attack_stats_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id text NOT NULL REFERENCES locations(id),
  region_name text NOT NULL,
  requested_by text NOT NULL CHECK (requested_by IN ('scheduler','operator','public')),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  -- Розрахунок про період, якого ще не було, — і за конструкцією не може назватися спостереженням.
  data_nature text NOT NULL DEFAULT 'calculated' CHECK (data_nature = 'calculated'),
  methodology_version text NOT NULL,
  prompt_version text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  forecast_from date NOT NULL,
  forecast_to date NOT NULL,
  last_episodes integer NOT NULL CHECK (last_episodes BETWEEN 3 AND 60),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  model text,
  ai_run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  -- `passed` — JSON розібрано й пуассонівський перерахунок сходиться з числами моделі;
  -- `inconsistent` — розібрано, але не сходиться (показується з попередженням);
  -- `rejected` — структурованих даних немає або вони непридатні (текст можна прочитати, графіків нема);
  -- `skipped` — модель не відповіла (звіт `failed`).
  verification text CHECK (verification IN ('passed','inconsistent','rejected','skipped')),
  rejection_reason text,
  failure_reason text,
  -- Повний текст відповіді моделі (markdown зі структурою КРОК 1–4).
  report_text text,
  -- JSON-блок для графіків у тому вигляді, в якому його віддала модель і прийняла схема.
  charts jsonb,
  -- Похідне: детермінований перерахунок Пуассона, календар прогнозу з рівнями, ключові висновки,
  -- епізоди — усе, що читають сторінка і бот, щоб не парсити markdown двічі.
  summary jsonb,
  CHECK (period_from <= period_to),
  CHECK (forecast_from <= forecast_to),
  CHECK (status <> 'completed' OR (finished_at IS NOT NULL AND verification IS NOT NULL))
);

-- Один активний запуск на регіон — дедуплікація черги, а не домовленість у коді.
CREATE UNIQUE INDEX IF NOT EXISTS attack_stats_reports_active_idx
  ON attack_stats_reports (region_id) WHERE status IN ('queued','running');
-- «Найсвіжіший готовий звіт по регіону» — читання сторінки, бота й перевірки свіжості.
CREATE INDEX IF NOT EXISTS attack_stats_reports_latest_idx
  ON attack_stats_reports (region_id, finished_at DESC) WHERE status = 'completed';
-- Черга у порядку постановки.
CREATE INDEX IF NOT EXISTS attack_stats_reports_queue_idx
  ON attack_stats_reports (queued_at) WHERE status = 'queued';
-- Денний ліміт і ретеншн читають саме цей стовпець.
CREATE INDEX IF NOT EXISTS attack_stats_reports_time_idx
  ON attack_stats_reports (queued_at DESC);

COMMENT ON TABLE attack_stats_reports IS
  'Статистика ударів і пуассонівський прогноз по регіону з відкритих джерел (модель із вебпошуком). Публікується на сторінці атак і в нічній аналітиці бота з дисклеймером; ні на що інше не впливає.';
COMMENT ON TABLE attack_stats_interest IS
  'Регіони, які обрали користувачі на сторінці атак. Обмежена кількістю регіонів; керує порядком планового проходу.';

-- ================================================================================================
-- Нічна аналітика без оцінок ризику
-- ================================================================================================
--
-- Досі нічний дайджест існував лише для переліку оцінок ризику: чат без чинної оцінки о 23:20 не
-- отримував нічого, і CHECK з міграції 001 вимагав від кожного рядка outbox хоч одного з трьох
-- ідентифікаторів. Статистика ударів — добовий продукт, і «спокійний вечір без оцінок» — це саме той
-- вечір, коли підписник хоче побачити, що каже базова частота по його області. Тому рядок типу
-- `nightly_digest` тепер може не нести `assessment_id`: чат отримує зведення, якщо в нього є або
-- оцінки, або статистика по його регіонах. Для решти типів вимога лишається незмінною.
DO $$
DECLARE
  existing text;
BEGIN
  SELECT conname INTO existing
    FROM pg_constraint
   WHERE conrelid = 'notification_outbox'::regclass AND contype = 'c'
     AND conname <> 'notification_outbox_subject_check'
     AND pg_get_constraintdef(oid) LIKE '%assessment_id IS NOT NULL%'
   LIMIT 1;
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notification_outbox DROP CONSTRAINT %I', existing);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_outbox_subject_check') THEN
    ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_subject_check
      CHECK (event_id IS NOT NULL OR alert_period_id IS NOT NULL OR assessment_id IS NOT NULL
             OR notification_type = 'nightly_digest');
  END IF;
END $$;
