-- Failed or error-interrupted turns gain a fixed failure category and the provider's
-- HTTP status. Additive: existing rows keep NULL and old clients omit both fields.
-- Apply before deploying the receiver that writes them. The receiver allowlists the
-- categories; the column only bounds length, so a new category needs no table rebuild.
ALTER TABLE product_events ADD COLUMN failure TEXT
  CHECK (failure IS NULL OR length(failure) BETWEEN 2 AND 32);
ALTER TABLE product_events ADD COLUMN http_status INTEGER
  CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599);
