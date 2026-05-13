PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quick_agent_genres (
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL,
  subgenre TEXT NOT NULL DEFAULT '',
  normalized_genre TEXT NOT NULL,
  normalized_subgenre TEXT NOT NULL DEFAULT '',
  genre_evidence TEXT NOT NULL DEFAULT '',
  subgenre_evidence TEXT NOT NULL DEFAULT '',
  fit_reason TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  confidence_score INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, normalized_genre, normalized_subgenre, category),
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_genres_lookup
  ON quick_agent_genres(normalized_genre, normalized_subgenre, active, confidence_score);

CREATE INDEX IF NOT EXISTS idx_quick_agent_genres_agent
  ON quick_agent_genres(agent_id, active, last_seen_at);

CREATE TABLE IF NOT EXISTS quick_agent_sources (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'profile',
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  last_status INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (agent_id, source_url),
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_sources_agent
  ON quick_agent_sources(agent_id, source_kind, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_quick_agent_sources_url
  ON quick_agent_sources(source_url);

CREATE TABLE IF NOT EXISTS quick_agent_requirements (
  agent_id TEXT PRIMARY KEY,
  query_method TEXT NOT NULL,
  submission_url TEXT NOT NULL DEFAULT '',
  public_email TEXT NOT NULL DEFAULT '',
  requirements_summary TEXT NOT NULL,
  required_materials_json TEXT NOT NULL DEFAULT '[]',
  wishlist_summary TEXT NOT NULL DEFAULT '',
  submission_requirements_json TEXT NOT NULL DEFAULT '{}',
  email_opener TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  verification_notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_requirements_method
  ON quick_agent_requirements(query_method, updated_at);

CREATE TABLE IF NOT EXISTS quick_agent_status_checks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  checked_url TEXT NOT NULL DEFAULT '',
  open_status TEXT NOT NULL,
  route_verified INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_status_checks_agent
  ON quick_agent_status_checks(agent_id, checked_at);

CREATE INDEX IF NOT EXISTS idx_quick_agent_status_checks_status
  ON quick_agent_status_checks(open_status, checked_at);
