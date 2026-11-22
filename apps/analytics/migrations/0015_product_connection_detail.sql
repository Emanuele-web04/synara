-- Connection events gain the client's network kind and the route the attempt used.
-- Failed connection attempts reuse the existing `failure`/`http_status` columns from
-- 0014. Additive: existing rows keep NULL and old clients omit both fields. Apply
-- before deploying the receiver that writes them. Both value sets are closed and small,
-- so the columns enumerate them; a new value needs a reviewed migration first.
ALTER TABLE product_events ADD COLUMN network TEXT
  CHECK (network IS NULL OR network IN ('wifi', 'cellular', 'wired', 'other', 'none'));
ALTER TABLE product_events ADD COLUMN route TEXT
  CHECK (route IS NULL OR route IN ('local', 'direct', 'tunnel'));
