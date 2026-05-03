ALTER TABLE autopilot_trigger ADD COLUMN IF NOT EXISTS event_name TEXT;
ALTER TABLE autopilot_trigger ADD COLUMN IF NOT EXISTS conditions JSONB DEFAULT '{}';
