-- Add repo_source column to github_objects for owned/starred distinction
ALTER TABLE github_objects ADD COLUMN repo_source TEXT DEFAULT 'owned';
