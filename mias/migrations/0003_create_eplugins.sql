-- External plugins (Levanter's Plugin table): one row per installed plugin.
-- name + session are unique together, as in Levanter; scope isolates bots that share a database.
CREATE TABLE IF NOT EXISTS mias_eplugins (
  scope text NOT NULL,
  session text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  source text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, session, name)
);

CREATE INDEX IF NOT EXISTS mias_eplugins_scope_session_idx ON mias_eplugins(scope, session, created_at);
