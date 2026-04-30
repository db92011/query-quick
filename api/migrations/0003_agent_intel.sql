PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quick_agent_cache (
  cache_key TEXT PRIMARY KEY,
  genre TEXT NOT NULL,
  subgenre TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  agents_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_agents (
  id TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL,
  agency TEXT NOT NULL,
  genre_fit TEXT NOT NULL,
  matched_genre TEXT NOT NULL DEFAULT '',
  matched_subgenre TEXT NOT NULL DEFAULT '',
  genre_evidence TEXT NOT NULL DEFAULT '',
  subgenre_evidence TEXT NOT NULL DEFAULT '',
  fit_reason TEXT NOT NULL DEFAULT '',
  query_method TEXT NOT NULL,
  submission_url TEXT NOT NULL DEFAULT '',
  public_email TEXT NOT NULL DEFAULT '',
  requirements_summary TEXT NOT NULL,
  required_materials_json TEXT NOT NULL DEFAULT '[]',
  email_opener TEXT NOT NULL DEFAULT '',
  open_status TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  verification_notes TEXT NOT NULL DEFAULT '',
  submission_route_verified INTEGER NOT NULL DEFAULT 0,
  submission_route_verified_at TEXT NOT NULL DEFAULT '',
  submission_route_status INTEGER NOT NULL DEFAULT 0,
  submission_route_notes TEXT NOT NULL DEFAULT '',
  refresh_status TEXT NOT NULL DEFAULT 'pending',
  refresh_error TEXT NOT NULL DEFAULT '',
  next_refresh_at TEXT NOT NULL DEFAULT '',
  last_verified TEXT NOT NULL,
  confidence_score INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_agents_email ON quick_agents(public_email);
CREATE INDEX IF NOT EXISTS idx_quick_agents_agency ON quick_agents(agency);
CREATE INDEX IF NOT EXISTS idx_quick_agents_last_seen ON quick_agents(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_quick_agents_open_refresh ON quick_agents(open_status, next_refresh_at);
CREATE INDEX IF NOT EXISTS idx_quick_agents_genre_fit ON quick_agents(genre_fit);

CREATE TABLE IF NOT EXISTS quick_agent_searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  genre TEXT NOT NULL,
  subgenre TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_searches_user ON quick_agent_searches(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quick_agent_searches_cache ON quick_agent_searches(cache_key, created_at);

CREATE TABLE IF NOT EXISTS quick_agent_search_results (
  search_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (search_id, agent_id),
  FOREIGN KEY (search_id) REFERENCES quick_agent_searches(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_search_results_agent ON quick_agent_search_results(agent_id, created_at);
