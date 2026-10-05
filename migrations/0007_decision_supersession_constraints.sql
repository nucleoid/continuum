-- Decision supersession must be a same-scope, same-type, linear chain.
-- Refuse to add constraints if existing data violates those invariants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM memories WHERE supersedes_id = id) THEN
    RAISE EXCEPTION 'invalid supersession data: a memory supersedes itself';
  END IF;
  IF EXISTS (
    SELECT supersedes_id FROM memories WHERE supersedes_id IS NOT NULL
     GROUP BY supersedes_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'invalid supersession data: predecessor has multiple successors';
  END IF;
  IF EXISTS (
    SELECT 1 FROM memories successor
      JOIN memories predecessor ON predecessor.id = successor.supersedes_id
     WHERE successor.type <> 'decision' OR predecessor.type <> 'decision'
        OR successor.scope_id <> predecessor.scope_id
  ) THEN
    RAISE EXCEPTION 'invalid supersession data: links must join decisions in one scope';
  END IF;
  IF EXISTS (
    WITH RECURSIVE walk AS (
      SELECT id AS start_id, supersedes_id AS next_id, ARRAY[id] AS path, false AS cycle
        FROM memories WHERE supersedes_id IS NOT NULL
      UNION ALL
      SELECT walk.start_id, predecessor.supersedes_id,
             walk.path || predecessor.id, predecessor.id = ANY(walk.path)
        FROM walk JOIN memories predecessor ON predecessor.id = walk.next_id
       WHERE walk.next_id IS NOT NULL AND NOT walk.cycle
    ) SELECT 1 FROM walk WHERE cycle
  ) THEN
    RAISE EXCEPTION 'invalid supersession data: cycle detected';
  END IF;
END $$;

-- Preview deployments may already have the constraint from the superseded
-- 0005 migration name. Keep their upgrade path idempotent while fresh installs
-- add it without scanning the table under the stronger ADD CONSTRAINT lock.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'memories'::regclass
       AND conname = 'memories_supersedes_not_self'
  ) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_supersedes_not_self
      CHECK (supersedes_id IS NULL OR supersedes_id <> id) NOT VALID;
  END IF;
END $$;
ALTER TABLE memories VALIDATE CONSTRAINT memories_supersedes_not_self;
