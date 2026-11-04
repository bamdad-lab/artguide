-- NULL means "balanced": the server rotates models scan by scan.
ALTER TABLE invites ADD COLUMN model TEXT;

-- Which model each scan was given, so every call within one scan uses the same model.
CREATE TABLE scan_models (
  scan_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  model TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX scan_models_model ON scan_models(model);
