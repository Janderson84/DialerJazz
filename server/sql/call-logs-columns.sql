-- Self-healing: recording + transcription columns on call_logs
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS call_sid text;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_url text;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transcription_sid text;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transcription_status text;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transcription text;
CREATE INDEX IF NOT EXISTS idx_call_logs_call_sid ON call_logs(call_sid);
