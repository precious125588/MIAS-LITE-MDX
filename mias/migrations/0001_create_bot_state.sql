CREATE TABLE IF NOT EXISTS mias_bot_state (
  scope text PRIMARY KEY CHECK (length(scope) BETWEEN 1 AND 80),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mias_bot_state_updated_at_idx
  ON mias_bot_state (updated_at);
