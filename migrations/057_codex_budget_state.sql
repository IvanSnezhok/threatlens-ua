-- 057 — останній відомий стан квоти Codex, щоб перезапуск не бив у вже вичерпаний ліміт.
--
-- ================================================================================================
-- Навіщо таблиця, коли бюджет рахується в памʼяті
-- ================================================================================================
--
-- 23.09.2026 п'ятигодинне вікно облікового запису (план plus) стояло на 100 % з 08:56 UTC, і кожна
-- поверхня далі кликала з тією самою частотою: понад дві тисячі відповідей 429 за дві години, жодна
-- нічого не дала. Бекенд на КОЖНУ відповідь — і 200, і 429 — шле заголовки `x-codex-primary-*` та
-- `x-codex-secondary-*`: скільки відсотків вікна вже витрачено, яке воно завдовжки і коли скинеться.
-- `src/services/codex-budget.ts` читає їх і вирішує ДО запиту, чи має поверхня право на виклик.
--
-- Рішення живе в памʼяті процесу, а знання — ні: перезапуск посеред вичерпаного вікна повертав би
-- процес у стан «нічого не відомо», і перша ж хвилина пішла б на ті самі 429, з яких він дізнався б
-- заново. Тому останній знімок лежить тут: процес читає його на першому виклику після старту.
--
-- Один рядок, як і в `telegram_delivery_governor` (міграція 038): облікових записів Codex на
-- інсталяцію рівно один, і квота одна. Пишеться лише тоді, коли знімок змінився, і не частіше ніж
-- раз на десять секунд — див. `codex-budget.ts`.
--
-- Усі поля, крім службових, можуть бути NULL: проксі chat/completions цих заголовків не шле, і
-- «нічого не відомо» — чесний стан, у якому бюджет нікого не зупиняє.

CREATE TABLE IF NOT EXISTS codex_budget_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  -- П'ятигодинне вікно (primary) і тижневе (secondary), як їх назвав бекенд.
  primary_used_percent real NULL CHECK (primary_used_percent IS NULL OR primary_used_percent >= 0),
  primary_window_minutes integer NULL CHECK (primary_window_minutes IS NULL OR primary_window_minutes > 0),
  primary_reset_at timestamptz NULL,
  secondary_used_percent real NULL CHECK (secondary_used_percent IS NULL OR secondary_used_percent >= 0),
  secondary_window_minutes integer NULL CHECK (secondary_window_minutes IS NULL OR secondary_window_minutes > 0),
  secondary_reset_at timestamptz NULL,
  plan_type text NULL,
  -- Коли відповідь 429 `usage_limit_reached` зупинила ВСІ поверхні, і до якого моменту.
  blocked_until timestamptz NULL,
  blocked_reason text NULL,
  -- Коли заголовки прочитано; `updated_at` — коли рядок записано.
  observed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO codex_budget_state(singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

COMMENT ON TABLE codex_budget_state IS
  'Останній відомий стан квоти Codex із заголовків x-codex-*: відсотки вікон, їхні скидання і блок після 429 usage_limit_reached. Один рядок; читається на старті процесу.';
