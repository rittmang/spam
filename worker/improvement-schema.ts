export const IMPROVEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, input_hash TEXT NOT NULL, family TEXT NOT NULL, label TEXT, reason_code TEXT NOT NULL, note TEXT NOT NULL, disposition TEXT NOT NULL, snapshot TEXT NOT NULL, request_hash TEXT NOT NULL, normalized_text TEXT NOT NULL, is_correction BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS feedback_source ON feedback_events(source,created_at DESC);
CREATE TABLE IF NOT EXISTS policy_drafts (id TEXT PRIMARY KEY, status TEXT NOT NULL, parent TEXT NOT NULL, payload TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS policy_drafts_status ON policy_drafts(status,created_at);
CREATE TABLE IF NOT EXISTS policy_versions (id TEXT PRIMARY KEY, parent TEXT NOT NULL, policy TEXT NOT NULL, settings TEXT NOT NULL, source TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS improvement_test_families (family TEXT PRIMARY KEY, draft_id TEXT NOT NULL, exposed_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS policy_reference_sets (draft_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policy_evidence_consumption (parent TEXT NOT NULL, family TEXT NOT NULL, PRIMARY KEY(parent,family));
CREATE TABLE IF NOT EXISTS improvement_test_inputs (input_hash TEXT PRIMARY KEY, draft_id TEXT NOT NULL, exposed_at BIGINT NOT NULL);
`;
