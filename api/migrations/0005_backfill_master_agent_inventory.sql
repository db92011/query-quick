PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO quick_agent_genres (
  agent_id,
  category,
  genre,
  subgenre,
  normalized_genre,
  normalized_subgenre,
  genre_evidence,
  subgenre_evidence,
  fit_reason,
  source_url,
  confidence_score,
  active,
  first_seen_at,
  last_seen_at
)
SELECT
  id,
  '',
  COALESCE(NULLIF(matched_genre, ''), genre_fit),
  COALESCE(NULLIF(matched_subgenre, ''), ''),
  lower(trim(COALESCE(NULLIF(matched_genre, ''), genre_fit))),
  lower(trim(COALESCE(NULLIF(matched_subgenre, ''), ''))),
  COALESCE(genre_evidence, ''),
  COALESCE(subgenre_evidence, ''),
  COALESCE(fit_reason, ''),
  COALESCE(source_url, ''),
  COALESCE(confidence_score, 0),
  CASE WHEN open_status IN ('open', 'selective') THEN 1 ELSE 0 END,
  COALESCE(NULLIF(first_seen_at, ''), datetime('now')),
  COALESCE(NULLIF(last_seen_at, ''), datetime('now'))
FROM quick_agents
WHERE COALESCE(NULLIF(matched_genre, ''), NULLIF(genre_fit, '')) IS NOT NULL;

INSERT OR IGNORE INTO quick_agent_requirements (
  agent_id,
  query_method,
  submission_url,
  public_email,
  requirements_summary,
  required_materials_json,
  wishlist_summary,
  submission_requirements_json,
  email_opener,
  source_url,
  source_urls_json,
  verification_notes,
  updated_at
)
SELECT
  id,
  query_method,
  COALESCE(submission_url, ''),
  COALESCE(public_email, ''),
  requirements_summary,
  COALESCE(required_materials_json, '[]'),
  trim(
    COALESCE(NULLIF(genre_evidence, ''), '') || ' ' ||
    COALESCE(NULLIF(subgenre_evidence, ''), '') || ' ' ||
    COALESCE(NULLIF(fit_reason, ''), '')
  ),
  json_object(
    'query_method', query_method,
    'submission_url', COALESCE(submission_url, ''),
    'public_email', COALESCE(public_email, ''),
    'route_url', CASE WHEN query_method = 'email' THEN COALESCE(source_url, '') ELSE COALESCE(NULLIF(submission_url, ''), source_url, '') END,
    'route_verified', CASE WHEN submission_route_verified = 1 THEN json('true') ELSE json('false') END,
    'route_status', COALESCE(submission_route_status, 0),
    'required_materials', json(COALESCE(required_materials_json, '[]')),
    'open_status', open_status,
    'last_verified', last_verified,
    'verification_notes', COALESCE(verification_notes, '')
  ),
  COALESCE(email_opener, ''),
  COALESCE(source_url, ''),
  COALESCE(source_urls_json, '[]'),
  COALESCE(verification_notes, ''),
  COALESCE(NULLIF(last_seen_at, ''), datetime('now'))
FROM quick_agents;

INSERT OR IGNORE INTO quick_agent_sources (
  id,
  agent_id,
  source_url,
  source_kind,
  title,
  notes,
  last_status,
  last_checked_at,
  first_seen_at,
  last_seen_at
)
SELECT
  id || ':source:primary',
  id,
  source_url,
  'profile',
  '',
  COALESCE(verification_notes, ''),
  0,
  '',
  COALESCE(NULLIF(first_seen_at, ''), datetime('now')),
  COALESCE(NULLIF(last_seen_at, ''), datetime('now'))
FROM quick_agents
WHERE COALESCE(source_url, '') != '';

INSERT OR IGNORE INTO quick_agent_sources (
  id,
  agent_id,
  source_url,
  source_kind,
  title,
  notes,
  last_status,
  last_checked_at,
  first_seen_at,
  last_seen_at
)
SELECT
  id || ':source:route',
  id,
  CASE WHEN query_method = 'email' THEN source_url ELSE COALESCE(NULLIF(submission_url, ''), source_url) END,
  'submission_route',
  'submission route',
  COALESCE(submission_route_notes, ''),
  COALESCE(submission_route_status, 0),
  COALESCE(submission_route_verified_at, ''),
  COALESCE(NULLIF(first_seen_at, ''), datetime('now')),
  COALESCE(NULLIF(last_seen_at, ''), datetime('now'))
FROM quick_agents
WHERE COALESCE(CASE WHEN query_method = 'email' THEN source_url ELSE COALESCE(NULLIF(submission_url, ''), source_url) END, '') != '';

INSERT OR IGNORE INTO quick_agent_status_checks (
  id,
  agent_id,
  checked_url,
  open_status,
  route_verified,
  status_code,
  notes,
  checked_at
)
SELECT
  id || ':status:backfill',
  id,
  CASE WHEN query_method = 'email' THEN source_url ELSE COALESCE(NULLIF(submission_url, ''), source_url, '') END,
  open_status,
  COALESCE(submission_route_verified, 0),
  COALESCE(submission_route_status, 0),
  COALESCE(submission_route_notes, verification_notes, ''),
  COALESCE(NULLIF(submission_route_verified_at, ''), NULLIF(last_verified, ''), datetime('now'))
FROM quick_agents
WHERE COALESCE(submission_route_verified, 0) = 1
   OR COALESCE(submission_route_status, 0) > 0
   OR COALESCE(submission_route_notes, '') != '';
