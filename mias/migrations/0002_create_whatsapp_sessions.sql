CREATE TABLE IF NOT EXISTS mias_session_auth (
  session_id text NOT NULL,
  file_name text NOT NULL,
  content text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, file_name)
);

CREATE INDEX IF NOT EXISTS mias_session_auth_session_id_idx ON mias_session_auth(session_id);
CREATE INDEX IF NOT EXISTS mias_session_auth_updated_at_idx ON mias_session_auth(updated_at);

CREATE TABLE IF NOT EXISTS mias_session_registry (
  jid text PRIMARY KEY,
  number text NOT NULL,
  source text DEFAULT 'web',
  status text DEFAULT 'connecting',
  telegram_user_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mias_session_registry_number_idx ON mias_session_registry(number);

CREATE TABLE IF NOT EXISTS mias_bot_selections (
  number text PRIMARY KEY,
  bot_id text NOT NULL,
  bot_name text NOT NULL,
  chosen_at timestamptz NOT NULL DEFAULT now(),
  source text DEFAULT 'unknown',
  chosen_by text,
  locked boolean NOT NULL DEFAULT true,
  deployed boolean NOT NULL DEFAULT false,
  deployed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
