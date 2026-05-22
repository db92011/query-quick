PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quick_agent_submission_schema (
  agent_id TEXT PRIMARY KEY,
  submission_method TEXT NOT NULL,
  submission_url TEXT NOT NULL DEFAULT '',
  requires_query_letter INTEGER NOT NULL DEFAULT 1,
  requires_synopsis INTEGER NOT NULL DEFAULT 0,
  synopsis_type TEXT NOT NULL DEFAULT '',
  requires_bio INTEGER NOT NULL DEFAULT 0,
  sample_pages INTEGER NOT NULL DEFAULT 0,
  attachment_rules_json TEXT NOT NULL DEFAULT '[]',
  form_fields_json TEXT NOT NULL DEFAULT '{}',
  querymanager_enabled INTEGER NOT NULL DEFAULT 0,
  email_submission_enabled INTEGER NOT NULL DEFAULT 0,
  last_verified TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 0,
  schema_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES quick_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quick_agent_submission_schema_method
  ON quick_agent_submission_schema(submission_method, sample_pages, updated_at);

CREATE INDEX IF NOT EXISTS idx_quick_agent_submission_schema_verified
  ON quick_agent_submission_schema(last_verified, confidence);

INSERT OR IGNORE INTO quick_agent_submission_schema (
  agent_id,
  submission_method,
  submission_url,
  requires_query_letter,
  requires_synopsis,
  synopsis_type,
  requires_bio,
  sample_pages,
  attachment_rules_json,
  form_fields_json,
  querymanager_enabled,
  email_submission_enabled,
  last_verified,
  confidence,
  schema_json,
  updated_at
)
SELECT
  qr.agent_id,
  qr.query_method,
  CASE WHEN qr.query_method = 'email' THEN COALESCE(qr.public_email, '') ELSE COALESCE(qr.submission_url, '') END,
  1,
  CASE WHEN lower(qr.required_materials_json) LIKE '%synopsis%' THEN 1 ELSE 0 END,
  CASE WHEN lower(qr.requirements_summary) LIKE '%1-page synopsis%' OR lower(qr.requirements_summary) LIKE '%one-page synopsis%' THEN '1_page' ELSE '' END,
  CASE WHEN lower(qr.required_materials_json) LIKE '%bio_paragraph%' THEN 1 ELSE 0 END,
  0,
  qr.required_materials_json,
  '{}',
  CASE WHEN qr.query_method = 'querymanager' THEN 1 ELSE 0 END,
  CASE WHEN qr.query_method = 'email' THEN 1 ELSE 0 END,
  COALESCE(NULLIF(qa.last_verified, ''), qr.updated_at),
  COALESCE(qa.confidence_score, 0),
  '{}',
  qr.updated_at
FROM quick_agent_requirements qr
JOIN quick_agents qa ON qa.id = qr.agent_id;
