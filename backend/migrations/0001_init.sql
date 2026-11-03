CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES invites(code),
  data TEXT NOT NULL,          -- the scan record as JSON, same shape as the app's export
  photo BLOB,                  -- JPEG, about 1568 px on the long side
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX scans_code ON scans(code, created_at);

CREATE TABLE calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  at INTEGER NOT NULL,
  model TEXT NOT NULL,
  served TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  searches INTEGER NOT NULL,
  usd REAL NOT NULL,
  status INTEGER NOT NULL
);
CREATE INDEX calls_code_at ON calls(code, at);
CREATE INDEX calls_at ON calls(at);
