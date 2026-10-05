-- Validate separately so the preceding migration releases its
-- AccessExclusiveLock before PostgreSQL scans existing rows.
ALTER TABLE memories VALIDATE CONSTRAINT memories_supersedes_not_self;
