PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quick_profiles (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  book_title TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  subgenre TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  word_count TEXT NOT NULL DEFAULT '',
  query_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quick_submission_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_submission_files_user ON quick_submission_files(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quick_submission_files_kind ON quick_submission_files(user_id, kind, created_at);

CREATE TABLE IF NOT EXISTS quick_submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agency TEXT NOT NULL,
  book_title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_submissions_user ON quick_submissions(user_id, created_at);

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  product TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_product ON waitlist(product, created_at);

CREATE TABLE IF NOT EXISTS subscriptions_quick (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'trialing',
  current_period_end TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
