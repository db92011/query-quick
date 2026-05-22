PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quick_genre_aliases (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  normalized_alias TEXT NOT NULL,
  canonical_genre TEXT NOT NULL,
  canonical_subgenre TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  confidence_score INTEGER NOT NULL DEFAULT 60,
  source TEXT NOT NULL DEFAULT 'engine',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_genre_aliases_lookup
  ON quick_genre_aliases(normalized_alias, active, confidence_score);

CREATE TABLE IF NOT EXISTS quick_agent_scores (
  agent_id TEXT PRIMARY KEY,
  open_score INTEGER NOT NULL DEFAULT 0,
  genre_fit_score INTEGER NOT NULL DEFAULT 0,
  wishlist_fit_score INTEGER NOT NULL DEFAULT 0,
  freshness_score INTEGER NOT NULL DEFAULT 0,
  confidence_score INTEGER NOT NULL DEFAULT 0,
  submission_ready_score INTEGER NOT NULL DEFAULT 0,
  final_rank_score INTEGER NOT NULL DEFAULT 0,
  score_reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_scores_rank
  ON quick_agent_scores(final_rank_score DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS quick_validated_agent_paths (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  path_key TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  genre_lane TEXT NOT NULL DEFAULT '',
  normalized_genre TEXT NOT NULL DEFAULT '',
  normalized_subgenre TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'watching',
  priority INTEGER NOT NULL DEFAULT 50,
  useful_agent_count INTEGER NOT NULL DEFAULT 0,
  open_agent_yield INTEGER NOT NULL DEFAULT 0,
  false_positive_count INTEGER NOT NULL DEFAULT 0,
  last_agent_id TEXT NOT NULL DEFAULT '',
  last_useful_at TEXT NOT NULL DEFAULT '',
  next_check_at TEXT NOT NULL DEFAULT '',
  confidence_score INTEGER NOT NULL DEFAULT 50,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (path_key, normalized_genre, normalized_subgenre)
);

CREATE INDEX IF NOT EXISTS idx_quick_validated_agent_paths_next
  ON quick_validated_agent_paths(status, next_check_at, priority DESC);

CREATE INDEX IF NOT EXISTS idx_quick_validated_agent_paths_genre
  ON quick_validated_agent_paths(normalized_genre, normalized_subgenre, status, priority DESC);

CREATE TABLE IF NOT EXISTS quick_agent_engine_jobs (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 50,
  agent_id TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  subgenre TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  scheduled_for TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_engine_jobs_queue
  ON quick_agent_engine_jobs(queue_name, status, priority DESC, scheduled_for, created_at);

CREATE INDEX IF NOT EXISTS idx_quick_agent_engine_jobs_agent
  ON quick_agent_engine_jobs(agent_id, job_type, status, created_at);

CREATE TABLE IF NOT EXISTS quick_agent_snapshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_snapshots_expiry
  ON quick_agent_snapshots(expires_at, snapshot_kind);

CREATE TABLE IF NOT EXISTS quick_agent_vectors (
  agent_id TEXT PRIMARY KEY,
  vector_id TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL DEFAULT 'wishlist',
  content_hash TEXT NOT NULL DEFAULT '',
  embedded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quick_notification_watches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  genre TEXT NOT NULL,
  subgenre TEXT NOT NULL DEFAULT '',
  normalized_genre TEXT NOT NULL,
  normalized_subgenre TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_notification_watches_genre
  ON quick_notification_watches(normalized_genre, normalized_subgenre, active);

CREATE TABLE IF NOT EXISTS quick_agent_notifications (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (watch_id) REFERENCES quick_notification_watches(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_notifications_pending
  ON quick_agent_notifications(sent_at, created_at);
