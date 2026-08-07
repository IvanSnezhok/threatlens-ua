CREATE TABLE IF NOT EXISTS recommended_telegram_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  username text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'monitoring'
    CHECK (category IN ('official','regional','monitoring','analytics')),
  location_id text REFERENCES locations(id) ON DELETE SET NULL,
  verified boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_by text NOT NULL DEFAULT 'operator',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recommended_telegram_channels_username_uidx
  ON recommended_telegram_channels (lower(username));
CREATE INDEX IF NOT EXISTS recommended_telegram_channels_public_idx
  ON recommended_telegram_channels (active,verified DESC,sort_order,title);

INSERT INTO recommended_telegram_channels
  (title,username,description,category,verified,sort_order,created_by)
VALUES
  ('Повітряні Сили ЗС України','kpszsu',
   'Офіційний канал Повітряних Сил Збройних Сил України.','official',true,10,'migration')
ON CONFLICT (lower(username)) DO NOTHING;
