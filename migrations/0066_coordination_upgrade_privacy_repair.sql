-- Reopen completed coordination privacy work after 0065 narrowed the
-- canonical lock-audit metadata shape. The existing scrubber performs the
-- audit rewrite in bounded keyset pages on the next offboarding pass.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

UPDATE coordination_principal_privacy_progress progress
   SET audit_cursor_id = 0,
       completed_at = NULL,
       updated_at = clock_timestamp()
  FROM principals principal
 WHERE principal.id = progress.principal_id
   AND principal.offboarded_at IS NOT NULL
   AND progress.privacy_version = 2
   AND progress.completed_at IS NOT NULL;
