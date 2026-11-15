-- Unlinked receipts are kept only for delivery deduplication.
CREATE TABLE reliability_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  received_day TEXT NOT NULL,
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  code TEXT NOT NULL
);

CREATE INDEX reliability_receipts_received_day ON reliability_receipts (received_day);

CREATE TABLE reliability_daily (
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  code TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, channel, app_version, platform, code)
);

-- The daily count and receipt commit together. A retried receipt never increments twice.
CREATE TRIGGER reliability_count AFTER INSERT ON reliability_receipts
BEGIN
  INSERT INTO reliability_daily (day, channel, app_version, platform, code, count)
  VALUES (NEW.day, NEW.channel, NEW.app_version, NEW.platform, NEW.code, 1)
  ON CONFLICT (day, channel, app_version, platform, code) DO UPDATE SET count = count + 1;
END;

-- A receipt acknowledges one exact record, even when a batch contains retries.
CREATE TRIGGER reliability_reject_conflicting_receipt BEFORE INSERT ON reliability_receipts
WHEN EXISTS (
  SELECT 1
  FROM reliability_receipts AS received
  WHERE received.receipt_id = NEW.receipt_id
    AND (
      received.day <> NEW.day OR received.channel <> NEW.channel
      OR received.app_version <> NEW.app_version OR received.platform <> NEW.platform
      OR received.code <> NEW.code
    )
)
BEGIN
  SELECT RAISE(ABORT, 'reliability receipt collision');
END;
