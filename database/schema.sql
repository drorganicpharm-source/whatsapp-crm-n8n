-- WhatsApp CRM schema (PostgreSQL on Railway)

CREATE TABLE IF NOT EXISTS customers (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    phone        TEXT UNIQUE NOT NULL,          -- E.164 format e.g. +9665xxxxxxxx
    status       TEXT NOT NULL DEFAULT 'new',   -- new | sent | failed | interested | not_interested | follow_up | asking_price | other
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
    id            SERIAL PRIMARY KEY,
    customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    message       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
    error_reason  TEXT,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    sent_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replies (
    id              SERIAL PRIMARY KEY,
    customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    message         TEXT NOT NULL,
    classification  TEXT,                       -- interested | not_interested | follow_up | asking_price | other
    raw_payload     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id);
CREATE INDEX IF NOT EXISTS idx_replies_customer ON replies(customer_id);

-- Dashboard-friendly view
CREATE OR REPLACE VIEW campaign_summary AS
SELECT
    (SELECT count(*) FROM customers) AS total_customers,
    (SELECT count(*) FROM messages WHERE status = 'sent') AS messages_sent,
    (SELECT count(*) FROM messages WHERE status = 'failed') AS messages_failed,
    (SELECT count(*) FROM customers WHERE status = 'interested') AS interested,
    (SELECT count(*) FROM customers WHERE status = 'not_interested') AS not_interested,
    (SELECT count(*) FROM customers WHERE status = 'follow_up') AS follow_up,
    (SELECT count(*) FROM customers WHERE status = 'asking_price') AS asking_price,
    (SELECT count(*) FROM customers c
        WHERE NOT EXISTS (SELECT 1 FROM replies r WHERE r.customer_id = c.id)
          AND c.status = 'sent') AS no_reply_yet;
