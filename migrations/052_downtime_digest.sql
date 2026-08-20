-- 052: зведення після простою — сповіщення, у якого немає предмета.
--
-- Чому. Зі стелею віку повідомлення (`SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES`, рішення власника
-- 20.08.2026) дозбір після простою більше не породжує ні подій, ні сповіщень: усе, старше за
-- годину, лягає в архів і в контекст локацій. Поодинці це правильно — попередження про те, що вже
-- скінчилося, є хибною тривогою, — але в цілому лишає читача ні з чим після трьох годин мовчання.
-- Тому за простій іде ОДНЕ тихе повідомлення на чат: що було, де і коли.
--
-- Що заважало. `notification_outbox_subject_check` вимагає, щоб кожен рядок черги вказував на щось
-- одне: подію, період тривоги або оцінку ризику. Міграція 048 уже зробила виняток для нічного
-- зведення з тієї самої причини — зведення говорить не про один предмет, а про добу. Зведення
-- простою говорить про вікно, і предмета в нього так само немає: подій, які воно переказує, у
-- `threat_events` може бути десяток, а може не бути жодної (повідомлення могло злитися в чужу
-- подію). Прив'язати рядок до однієї з них означало б збрехати про те, чим це повідомлення є.
--
-- Що НЕ змінюється. Ні `alert_periods`, ні `threat_events`, ні `system_event_log`: зведення читає
-- архів і пише в чергу, і жоден його рядок не може стати тривогою, відбоєм чи подією на карті.
--
-- Курсор проходу живе у `worker_state('downtime-digest')` і не потребує схеми: таблиця вже є з
-- міграції 001.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_outbox_subject_check') THEN
    ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_subject_check;
  END IF;
  ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_subject_check
    CHECK (event_id IS NOT NULL OR alert_period_id IS NOT NULL OR assessment_id IS NOT NULL
           OR notification_type IN ('nightly_digest', 'downtime_digest'));
END $$;

COMMENT ON CONSTRAINT notification_outbox_subject_check ON notification_outbox IS
  'Кожен рядок черги вказує на свій предмет — подію, період тривоги або оцінку. Виняток — зведення '
  '(nightly_digest, downtime_digest): вони говорять про вікно часу, а не про один предмет.';
