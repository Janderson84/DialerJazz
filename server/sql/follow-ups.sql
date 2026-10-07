-- follow-ups (callback scheduling) schema guard.
-- ensure-schema runs this at boot: creates the table if missing and, on the
-- live DB, adds the FK constraints PostgREST needs to resolve the embedded
-- leads(...) join in GET /api/followups.

CREATE TABLE IF NOT EXISTS follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  lead_id uuid,
  campaign_id uuid,
  due_at timestamptz NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS follow_ups_due_idx ON follow_ups (due_at);
CREATE INDEX IF NOT EXISTS follow_ups_user_status_idx ON follow_ups (user_id, status);

-- FKs (idempotent): required for the PostgREST resource embed leads(...)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'follow_ups_lead_fk'
  ) THEN
    ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_lead_fk
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'follow_ups_campaign_fk'
  ) THEN
    ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_campaign_fk
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
  END IF;
END $$;
