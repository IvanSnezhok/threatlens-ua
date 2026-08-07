CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS locations (
  id text PRIMARY KEY,
  parent_id text REFERENCES locations(id),
  type text NOT NULL CHECK (type IN ('country','oblast','special_city','raion','hromada','city')),
  name_uk text NOT NULL,
  official_code text,
  timezone text NOT NULL DEFAULT 'Europe/Kyiv',
  latitude double precision,
  longitude double precision,
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  name text NOT NULL,
  source_type text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('A','B','C')),
  official boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  adapter_type text NOT NULL,
  independence_group text NOT NULL,
  expected_update_interval_seconds integer NOT NULL DEFAULT 60,
  stale_after_seconds integer NOT NULL DEFAULT 180,
  public_url text,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  external_id text NOT NULL,
  published_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  raw_text text NOT NULL DEFAULT '',
  raw_payload jsonb NOT NULL DEFAULT '{}',
  content_hash text NOT NULL,
  processing_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id, content_hash)
);
CREATE INDEX IF NOT EXISTS source_messages_published_idx ON source_messages (published_at DESC);

CREATE TABLE IF NOT EXISTS source_message_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid NOT NULL REFERENCES source_messages(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  raw_text text NOT NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_message_id, revision_number)
);

CREATE TABLE IF NOT EXISTS alert_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL REFERENCES locations(id),
  alert_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','ended')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  source_message_id uuid REFERENCES source_messages(id),
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, alert_type, started_at)
);
CREATE INDEX IF NOT EXISTS alert_periods_active_idx ON alert_periods (location_id, status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS threat_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('observed','confirmed','active','expired','corrected','withdrawn')),
  evidence_level text NOT NULL CHECK (evidence_level IN ('official','confirmed','monitoring','unverified')),
  title text NOT NULL,
  summary text NOT NULL,
  started_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  ended_at timestamptz,
  direction_text text,
  geometry jsonb,
  geometry_semantics text,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS threat_events_live_idx ON threat_events (status, last_observed_at DESC);

CREATE TABLE IF NOT EXISTS threat_event_locations (
  event_id uuid NOT NULL REFERENCES threat_events(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id),
  relation_type text NOT NULL CHECK (relation_type IN ('explicit_threat','mentioned','reported_direction','official_alert','aftermath')),
  PRIMARY KEY (event_id, location_id, relation_type)
);

CREATE TABLE IF NOT EXISTS event_evidence (
  event_id uuid NOT NULL REFERENCES threat_events(id) ON DELETE CASCADE,
  source_message_id uuid NOT NULL REFERENCES source_messages(id) ON DELETE CASCADE,
  evidence_role text NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 0.5,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS event_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES threat_events(id) ON DELETE CASCADE,
  previous_status text,
  new_status text NOT NULL,
  previous_evidence_level text,
  new_evidence_level text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type text NOT NULL,
  source_message_id uuid REFERENCES source_messages(id),
  location_id text REFERENCES locations(id),
  threat_type text NOT NULL,
  source_tier text NOT NULL,
  independence_group text NOT NULL,
  reliability numeric(4,3) NOT NULL,
  freshness numeric(4,3) NOT NULL,
  geographic_relevance numeric(4,3) NOT NULL,
  contribution numeric(5,3) NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL REFERENCES locations(id),
  threat_type text NOT NULL,
  horizon_start timestamptz NOT NULL,
  horizon_end timestamptz NOT NULL,
  risk_score numeric(4,1) NOT NULL CHECK (risk_score BETWEEN 0 AND 10),
  risk_level text NOT NULL CHECK (risk_level IN ('background','elevated','significant','high','very_high')),
  assessment_confidence text NOT NULL CHECK (assessment_confidence IN ('low','medium','high')),
  model_version text NOT NULL,
  explanation jsonb NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  published boolean NOT NULL DEFAULT false,
  superseded_by uuid REFERENCES risk_assessments(id)
);
CREATE INDEX IF NOT EXISTS risk_assessments_live_idx ON risk_assessments (location_id, threat_type, expires_at DESC);

CREATE TABLE IF NOT EXISTS risk_assessment_signals (
  assessment_id uuid NOT NULL REFERENCES risk_assessments(id) ON DELETE CASCADE,
  signal_id uuid NOT NULL REFERENCES risk_signals(id) ON DELETE CASCADE,
  contribution numeric(5,3) NOT NULL,
  explanation text NOT NULL,
  PRIMARY KEY (assessment_id, signal_id)
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL,
  prompt_version text NOT NULL,
  input jsonb NOT NULL,
  output jsonb,
  status text NOT NULL,
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_users (
  chat_id bigint PRIMARY KEY,
  username text,
  language text NOT NULL DEFAULT 'uk',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL REFERENCES telegram_users(chat_id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id),
  threat_type text NOT NULL DEFAULT '*',
  minimum_evidence_level text NOT NULL DEFAULT 'official',
  notify_alert_start boolean NOT NULL DEFAULT true,
  notify_alert_end boolean NOT NULL DEFAULT true,
  notify_analytics boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (chat_id, location_id, threat_type)
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid,
  alert_period_id uuid REFERENCES alert_periods(id),
  assessment_id uuid REFERENCES risk_assessments(id),
  chat_id bigint NOT NULL REFERENCES telegram_users(chat_id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  priority integer NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK (event_id IS NOT NULL OR alert_period_id IS NOT NULL OR assessment_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON notification_outbox (priority, next_attempt_at) WHERE status IN ('pending','retry');

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES notification_outbox(id),
  telegram_message_id bigint,
  delivered_status text NOT NULL,
  error_code text,
  queued_at timestamptz NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_event_log (
  version bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_state (
  worker_name text PRIMARY KEY,
  cursor_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO locations (id, type, name_uk, latitude, longitude, aliases) VALUES
('ua', 'country', 'Україна', 48.3794, 31.1656, ARRAY['україна','україни']),
('ua-05','oblast','Вінницька область',49.2331,28.4682,ARRAY['вінниччина','вінницька область']),
('ua-07','oblast','Волинська область',50.7472,25.3254,ARRAY['волинь','волинська область']),
('ua-12','oblast','Дніпропетровська область',48.4647,35.0462,ARRAY['дніпропетровщина','дніпропетровська область']),
('ua-14','oblast','Донецька область',48.0159,37.8028,ARRAY['донеччина','донецька область']),
('ua-18','oblast','Житомирська область',50.2547,28.6587,ARRAY['житомирщина','житомирська область']),
('ua-21','oblast','Закарпатська область',48.6208,22.2879,ARRAY['закарпаття','закарпатська область']),
('ua-23','oblast','Запорізька область',47.8388,35.1396,ARRAY['запоріжжя','запорізька область']),
('ua-26','oblast','Івано-Франківська область',48.9226,24.7111,ARRAY['прикарпаття','івано-франківська область']),
('ua-32','oblast','Київська область',50.4501,30.5234,ARRAY['київщина','київська область']),
('ua-35','oblast','Кіровоградська область',48.5079,32.2623,ARRAY['кіровоградщина','кіровоградська область']),
('ua-44','oblast','Луганська область',48.5740,39.3078,ARRAY['луганщина','луганська область']),
('ua-46','oblast','Львівська область',49.8397,24.0297,ARRAY['львівщина','львівська область']),
('ua-48','oblast','Миколаївська область',46.9750,31.9946,ARRAY['миколаївщина','миколаївська область']),
('ua-51','oblast','Одеська область',46.4825,30.7233,ARRAY['одещина','одеська область']),
('ua-53','oblast','Полтавська область',49.5883,34.5514,ARRAY['полтавщина','полтавська область']),
('ua-56','oblast','Рівненська область',50.6199,26.2516,ARRAY['рівненщина','рівненська область']),
('ua-59','oblast','Сумська область',50.9077,34.7981,ARRAY['сумщина','сумська область']),
('ua-61','oblast','Тернопільська область',49.5535,25.5948,ARRAY['тернопільщина','тернопільська область']),
('ua-63','oblast','Харківська область',49.9935,36.2304,ARRAY['харківщина','харківська область']),
('ua-65','oblast','Херсонська область',46.6354,32.6169,ARRAY['херсонщина','херсонська область']),
('ua-68','oblast','Хмельницька область',49.4229,26.9871,ARRAY['хмельниччина','хмельницька область']),
('ua-71','oblast','Черкаська область',49.4444,32.0598,ARRAY['черкащина','черкаська область']),
('ua-73','oblast','Чернівецька область',48.2915,25.9403,ARRAY['буковина','чернівецька область']),
('ua-74','oblast','Чернігівська область',51.4982,31.2893,ARRAY['чернігівщина','чернігівська область']),
('ua-80','special_city','Київ',50.4501,30.5234,ARRAY['київ','києва','києві']),
('ua-85','special_city','Севастополь',44.6167,33.5254,ARRAY['севастополь']),
('ua-43','oblast','Автономна Республіка Крим',45.3453,34.4997,ARRAY['крим','автономна республіка крим'])
ON CONFLICT (id) DO NOTHING;

INSERT INTO sources (id,name,source_type,tier,official,adapter_type,independence_group,public_url) VALUES
('ukraine-alarm','Повітряна тривога','api','A',true,'ukraine_alarm','official-civil-alerts','https://map.ukrainealarm.com/'),
('air-force','Повітряні сили ЗСУ','telegram','A',true,'mtproto','air-force','https://t.me/kpszsu'),
('demo','Демонстраційне джерело','fixture','C',false,'demo','demo',NULL)
ON CONFLICT (id) DO NOTHING;

CREATE MATERIALIZED VIEW IF NOT EXISTS monthly_alert_summary AS
SELECT date_trunc('month', started_at AT TIME ZONE 'Europe/Kyiv')::date AS month,
       location_id, alert_type, count(*)::integer AS alerts_count,
       sum(ended_at - started_at) AS total_duration,
       avg(ended_at - started_at) AS average_duration,
       max(ended_at - started_at) AS longest_duration
FROM alert_periods WHERE ended_at IS NOT NULL
GROUP BY 1,2,3
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS monthly_alert_summary_uidx ON monthly_alert_summary (month, location_id, alert_type);

CREATE MATERIALIZED VIEW IF NOT EXISTS monthly_threat_summary AS
SELECT date_trunc('month', e.started_at AT TIME ZONE 'Europe/Kyiv')::date AS month,
       el.location_id, e.threat_type, e.evidence_level,
       count(DISTINCT e.id)::integer AS threat_events
FROM threat_events e JOIN threat_event_locations el ON el.event_id = e.id
GROUP BY 1,2,3,4
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS monthly_threat_summary_uidx ON monthly_threat_summary (month, location_id, threat_type, evidence_level);

REFRESH MATERIALIZED VIEW monthly_alert_summary;
REFRESH MATERIALIZED VIEW monthly_threat_summary;
