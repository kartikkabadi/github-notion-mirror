-- Add repo_source column to github_objects for owned/starred distinction
ALTER TABLE github_objects ADD COLUMN repo_source TEXT DEFAULT 'owned';

CREATE INDEX IF NOT EXISTS idx_github_objects_repo_source ON github_objects(repo_source);
