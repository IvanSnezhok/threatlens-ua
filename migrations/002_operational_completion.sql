ALTER TABLE sources ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE sources ADD CONSTRAINT sources_health_status_check
  CHECK (health_status IN ('unknown','current','stale','error','disabled')) NOT VALID;

ALTER TABLE source_messages ADD COLUMN IF NOT EXISTS supersedes_message_id uuid REFERENCES source_messages(id);
CREATE INDEX IF NOT EXISTS source_messages_external_idx ON source_messages(source_id, external_id, received_at DESC);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS notify_threats boolean NOT NULL DEFAULT true;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS notify_quiet boolean NOT NULL DEFAULT false;

ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS methodology_version text NOT NULL DEFAULT 'v2';
ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS indicative_percent integer;
ALTER TABLE risk_assessments ADD CONSTRAINT risk_assessments_indicative_percent_check
  CHECK (indicative_percent IS NULL OR indicative_percent BETWEEN 0 AND 100) NOT VALID;

CREATE TABLE IF NOT EXISTS nightly_digest_runs (
  digest_date date NOT NULL,
  chat_id bigint NOT NULL REFERENCES telegram_users(chat_id) ON DELETE CASCADE,
  outbox_id uuid REFERENCES notification_outbox(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_date, chat_id)
);

CREATE TABLE IF NOT EXISTS alert_source_states (
  source_id text NOT NULL REFERENCES sources(id),
  location_id text NOT NULL REFERENCES locations(id),
  alert_type text NOT NULL,
  active boolean NOT NULL,
  provider_started_at timestamptz,
  external_id text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id,location_id,alert_type)
);
CREATE INDEX IF NOT EXISTS alert_source_states_active_idx
  ON alert_source_states(location_id,alert_type) WHERE active=true;

INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,independence_group,public_url) VALUES
('alerts-in-ua','Alerts.in.ua API','api','A',true,false,'alerts_in_ua','official-civil-alerts','https://alerts.in.ua/')
ON CONFLICT (id) DO NOTHING;

INSERT INTO locations (id,parent_id,type,name_uk,latitude,longitude,aliases) VALUES
('ua-city-vinnytsia','ua-05','city','Вінниця',49.2331,28.4682,ARRAY['вінниця','вінниці','вінницю']),
('ua-city-lutsk','ua-07','city','Луцьк',50.7472,25.3254,ARRAY['луцьк','луцька','луцьку']),
('ua-city-dnipro','ua-12','city','Дніпро',48.4647,35.0462,ARRAY['дніпро','дніпра','дніпрі']),
('ua-city-kryvyi-rih','ua-12','city','Кривий Ріг',47.9105,33.3918,ARRAY['кривий ріг','кривого рогу','кривому розі']),
('ua-city-pavlohrad','ua-12','city','Павлоград',48.5296,35.9030,ARRAY['павлоград','павлограда','павлограді']),
('ua-city-donetsk','ua-14','city','Донецьк',48.0159,37.8028,ARRAY['донецьк','донецька','донецьку']),
('ua-city-kramatorsk','ua-14','city','Краматорськ',48.7389,37.5844,ARRAY['краматорськ','краматорська','краматорську']),
('ua-city-zhytomyr','ua-18','city','Житомир',50.2547,28.6587,ARRAY['житомир','житомира','житомирі']),
('ua-city-uzhhorod','ua-21','city','Ужгород',48.6208,22.2879,ARRAY['ужгород','ужгорода','ужгороді']),
('ua-city-zaporizhzhia','ua-23','city','Запоріжжя',47.8388,35.1396,ARRAY['запоріжжя','запоріжжі','запоріжжю']),
('ua-city-ivano-frankivsk','ua-26','city','Івано-Франківськ',48.9226,24.7111,ARRAY['івано-франківськ','франківськ','івано-франківська']),
('ua-city-bila-tserkva','ua-32','city','Біла Церква',49.7956,30.1311,ARRAY['біла церква','білої церкви','білій церкві']),
('ua-city-kropyvnytskyi','ua-35','city','Кропивницький',48.5079,32.2623,ARRAY['кропивницький','кропивницького','кропивницькому']),
('ua-city-luhansk','ua-44','city','Луганськ',48.5740,39.3078,ARRAY['луганськ','луганська','луганську']),
('ua-city-lviv','ua-46','city','Львів',49.8397,24.0297,ARRAY['львів','львова','львові']),
('ua-city-mykolaiv','ua-48','city','Миколаїв',46.9750,31.9946,ARRAY['миколаїв','миколаєва','миколаєві']),
('ua-city-odesa','ua-51','city','Одеса',46.4825,30.7233,ARRAY['одеса','одеси','одесі','одесу']),
('ua-city-poltava','ua-53','city','Полтава',49.5883,34.5514,ARRAY['полтава','полтави','полтаві','полтаву']),
('ua-city-rivne','ua-56','city','Рівне',50.6199,26.2516,ARRAY['рівне','рівного','рівному']),
('ua-city-sumy','ua-59','city','Суми',50.9077,34.7981,ARRAY['суми','сум','сумах']),
('ua-city-ternopil','ua-61','city','Тернопіль',49.5535,25.5948,ARRAY['тернопіль','тернополя','тернополі']),
('ua-city-kharkiv','ua-63','city','Харків',49.9935,36.2304,ARRAY['харків','харкова','харкові']),
('ua-city-kherson','ua-65','city','Херсон',46.6354,32.6169,ARRAY['херсон','херсона','херсоні']),
('ua-city-khmelnytskyi','ua-68','city','Хмельницький',49.4229,26.9871,ARRAY['хмельницький','хмельницького','хмельницькому']),
('ua-city-cherkasy','ua-71','city','Черкаси',49.4444,32.0598,ARRAY['черкаси','черкас','черкасах']),
('ua-city-chernivtsi','ua-73','city','Чернівці',48.2915,25.9403,ARRAY['чернівці','чернівців','чернівцях']),
('ua-city-chernihiv','ua-74','city','Чернігів',51.4982,31.2893,ARRAY['чернігів','чернігова','чернігові'])
ON CONFLICT (id) DO NOTHING;
