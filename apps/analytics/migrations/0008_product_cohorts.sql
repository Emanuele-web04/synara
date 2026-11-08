-- Aggregate reporting cohorts without retaining an installation journey beyond raw retention.
-- Apply before deploying the cohort-capable receiver; old clients omit these nullable fields.
ALTER TABLE product_events ADD COLUMN cohort_day TEXT;
ALTER TABLE product_events ADD COLUMN cohort_stage TEXT
  CHECK (cohort_stage IS NULL OR cohort_stage IN ('new', 'week1', 'month1'));

-- At most one report per stage even if a client loses its local once marker.
CREATE UNIQUE INDEX idx_product_cohort_stage
  ON product_events (install_id, channel, surface, cohort_day, cohort_stage)
  WHERE cohort_stage IS NOT NULL;

CREATE TABLE product_cohorts (
  cohort_day TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'remote')),
  surface TEXT NOT NULL CHECK (surface IN ('desktop', 'ios', 'ipados')),
  entries INTEGER NOT NULL DEFAULT 0,
  week1_returns INTEGER NOT NULL DEFAULT 0,
  month1_returns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cohort_day, channel, surface)
);

-- Raw UUID dedup and aggregate increments commit together, including request retries.
CREATE TRIGGER product_cohort_insert AFTER INSERT ON product_events
WHEN NEW.cohort_stage IS NOT NULL
BEGIN
  INSERT INTO product_cohorts (cohort_day, channel, surface, entries, week1_returns, month1_returns)
  VALUES (NEW.cohort_day, NEW.channel, NEW.surface,
    NEW.cohort_stage = 'new', NEW.cohort_stage = 'week1', NEW.cohort_stage = 'month1')
  ON CONFLICT (cohort_day, channel, surface) DO UPDATE SET
    entries = entries + excluded.entries,
    week1_returns = week1_returns + excluded.week1_returns,
    month1_returns = month1_returns + excluded.month1_returns;
END;

-- A temporarily older receiver can have stored this UUID without understanding cohorts.
CREATE TRIGGER product_cohort_upgrade AFTER UPDATE OF cohort_stage ON product_events
WHEN OLD.cohort_stage IS NULL AND NEW.cohort_stage IS NOT NULL
BEGIN
  INSERT INTO product_cohorts (cohort_day, channel, surface, entries, week1_returns, month1_returns)
  VALUES (NEW.cohort_day, NEW.channel, NEW.surface,
    NEW.cohort_stage = 'new', NEW.cohort_stage = 'week1', NEW.cohort_stage = 'month1')
  ON CONFLICT (cohort_day, channel, surface) DO UPDATE SET
    entries = entries + excluded.entries,
    week1_returns = week1_returns + excluded.week1_returns,
    month1_returns = month1_returns + excluded.month1_returns;
END;
