-- Binance BTC Price Storage Schema

CREATE TABLE IF NOT EXISTS btc_prices (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20)     NOT NULL DEFAULT 'BTCUSDT',
    price           DECIMAL(20, 8)  NOT NULL,
    high_24h        DECIMAL(20, 8),
    low_24h         DECIMAL(20, 8),
    volume_24h      DECIMAL(20, 8),
    price_change_pct DECIMAL(10, 4),
    timestamp       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Index for fast time-range queries
CREATE INDEX IF NOT EXISTS idx_btc_prices_timestamp ON btc_prices(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_btc_prices_symbol    ON btc_prices(symbol);

-- Cleanup function: removes data older than 30 days
CREATE OR REPLACE FUNCTION cleanup_old_prices() RETURNS void AS $$
BEGIN
    DELETE FROM btc_prices WHERE timestamp < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
