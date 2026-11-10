-- Keep daily totals and short-lived, unlinked receipts for delivery retries.
CREATE TABLE anonymous_product_daily (
  day TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'remote')),
  event TEXT NOT NULL CHECK (event IN ('remote.pairing-approved', 'remote.connection-succeeded', 'remote.reconnection-succeeded', 'remote.connection-timeout', 'app.crash')),
  count INTEGER NOT NULL,
  PRIMARY KEY (day, channel, event)
);

CREATE TABLE anonymous_product_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  event TEXT NOT NULL
);

CREATE INDEX anonymous_product_receipts_day ON anonymous_product_receipts (day);

-- One insert and its increment commit together. An ignored replay never fires this trigger.
CREATE TRIGGER anonymous_product_count AFTER INSERT ON anonymous_product_receipts
BEGIN
  INSERT INTO anonymous_product_daily (day, channel, event, count)
  VALUES (NEW.day, NEW.channel, NEW.event, 1)
  ON CONFLICT (day, channel, event) DO UPDATE SET count = count + 1;
END;
