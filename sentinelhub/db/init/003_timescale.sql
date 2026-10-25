-- Run only on TimescaleDB-enabled servers (the docker-compose image has it).
CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('track.track_point', 'ts', chunk_time_interval => interval '1 day', if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('telemetry.reading', 'ts', chunk_time_interval => interval '1 day', if_not_exists => TRUE, migrate_data => TRUE);

ALTER TABLE track.track_point SET (timescaledb.compress, timescaledb.compress_segmentby = 'radar_id');
ALTER TABLE telemetry.reading SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id, metric');
SELECT add_compression_policy('track.track_point', interval '1 day', if_not_exists => TRUE);
SELECT add_compression_policy('telemetry.reading', interval '1 day', if_not_exists => TRUE);
SELECT add_retention_policy('track.track_point', interval '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry.reading', interval '30 days', if_not_exists => TRUE);

DROP VIEW IF EXISTS telemetry.reading_1m;
CREATE MATERIALIZED VIEW telemetry.reading_1m_cagg
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket, device_id, metric,
       avg(value) AS avg, min(value) AS min, max(value) AS max
FROM telemetry.reading GROUP BY 1,2,3
WITH NO DATA;
SELECT add_continuous_aggregate_policy('telemetry.reading_1m_cagg',
  start_offset => interval '2 hours', end_offset => interval '1 minute', schedule_interval => interval '1 minute');
CREATE VIEW telemetry.reading_1m AS SELECT * FROM telemetry.reading_1m_cagg;
