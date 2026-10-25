-- SentinelHub core schema. Runs on PostgreSQL 15+ with PostGIS. TimescaleDB is optional (see 003).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS iam;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS geo;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS track;
CREATE SCHEMA IF NOT EXISTS telemetry;
CREATE SCHEMA IF NOT EXISTS firmware;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------- IAM / RBAC
CREATE TABLE iam.role (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  tier        int  NOT NULL,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE iam.role_permission (
  role_id    text NOT NULL REFERENCES iam.role(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE iam.app_user (
  id            uuid PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  agency        text NOT NULL,
  external_id   text,                 -- AD objectGUID / SAML NameID / OIDC sub
  password_hash text,                 -- NULL for federated users; seeded users are hashed by the API on start
  enabled       boolean NOT NULL DEFAULT true
);

-- A grant binds (user, role) to a node of the resource tree. Deny overrides allow.
CREATE TABLE iam.grant (
  id         bigserial PRIMARY KEY,
  user_id    uuid  NOT NULL REFERENCES iam.app_user(id) ON DELETE CASCADE,
  role_id    text  NOT NULL REFERENCES iam.role(id),
  node_path  ltree NOT NULL,
  effect     text  NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  expires_at timestamptz
);
CREATE INDEX grant_user_idx ON iam.grant (user_id);
CREATE INDEX grant_path_gist ON iam.grant USING gist (node_path);

-- ---------------------------------------------------------------- Inventory
CREATE TABLE inventory.site (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('edge','main')),
  node_path ltree NOT NULL UNIQUE,
  geom      geometry(Point,4326) NOT NULL,
  wan_mbps  double precision NOT NULL DEFAULT 0,
  status    text NOT NULL DEFAULT 'online'
);

CREATE TABLE inventory.device (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      text NOT NULL REFERENCES inventory.site(id),
  kind         text NOT NULL CHECK (kind IN ('camera','radar','iot_gateway','sensor')),
  name         text NOT NULL,
  vendor       text NOT NULL DEFAULT '',
  model        text NOT NULL DEFAULT '',
  firmware     text NOT NULL DEFAULT '1.0.0',
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','provisioned','active','offline','maintenance','decommissioned')),
  ip           inet,
  heading      double precision NOT NULL DEFAULT 0,
  node_path    ltree NOT NULL UNIQUE,
  geom         geometry(Point,4326) NOT NULL,
  cert_serial  text,
  cert_expires timestamptz,
  last_seen    timestamptz,
  attrs        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX device_site_idx ON inventory.device (site_id, kind);
CREATE INDEX device_path_gist ON inventory.device USING gist (node_path);
CREATE INDEX device_geom_gist ON inventory.device USING gist (geom);
CREATE INDEX device_attrs_gin ON inventory.device USING gin (attrs);

-- ---------------------------------------------------------------- Geo
CREATE TABLE geo.camera_fov (
  device_id uuid PRIMARY KEY REFERENCES inventory.device(id) ON DELETE CASCADE,
  fov       geometry(Polygon,4326) NOT NULL
);
CREATE INDEX camera_fov_gist ON geo.camera_fov USING gist (fov);

CREATE TABLE geo.geofence (
  id         serial PRIMARY KEY,
  site_id    text NOT NULL REFERENCES inventory.site(id),
  name       text NOT NULL,
  restricted boolean NOT NULL DEFAULT true,
  geom       geometry(Polygon,4326) NOT NULL
);
CREATE INDEX geofence_gist ON geo.geofence USING gist (geom);

-- ---------------------------------------------------------------- Operations
CREATE TABLE ops.event (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts        timestamptz NOT NULL DEFAULT now(),
  site_id   text NOT NULL REFERENCES inventory.site(id),
  device_id uuid REFERENCES inventory.device(id) ON DELETE SET NULL,
  node_path ltree NOT NULL,
  severity  text NOT NULL CHECK (severity IN ('info','warning','major','critical')),
  kind      text NOT NULL,
  message   text NOT NULL,
  state     text NOT NULL DEFAULT 'new' CHECK (state IN ('new','ack','closed')),
  ack_by    text,
  ack_at    timestamptz,
  geom      geometry(Point,4326)
);
CREATE INDEX event_ts_idx ON ops.event (ts DESC);
CREATE INDEX event_path_gist ON ops.event USING gist (node_path);

-- ---------------------------------------------------------------- Time series (hypertables when Timescale is present)
CREATE TABLE track.track_point (
  ts       timestamptz NOT NULL,
  radar_id uuid NOT NULL,
  track_id text NOT NULL,
  class    text NOT NULL,
  speed    double precision NOT NULL,
  heading  double precision NOT NULL,
  geom     geometry(Point,4326) NOT NULL
);
CREATE INDEX track_point_idx ON track.track_point (track_id, ts DESC);
CREATE INDEX track_point_ts_idx ON track.track_point (ts DESC);

CREATE TABLE telemetry.reading (
  ts        timestamptz NOT NULL,
  device_id uuid NOT NULL,
  metric    text NOT NULL,
  value     double precision NOT NULL
);
CREATE INDEX reading_idx ON telemetry.reading (device_id, metric, ts DESC);

-- 1-minute rollup. Replaced by a continuous aggregate by 003_timescale.sql when available.
CREATE VIEW telemetry.reading_1m AS
SELECT date_trunc('minute', ts) AS bucket, device_id, metric,
       avg(value) AS avg, min(value) AS min, max(value) AS max
FROM telemetry.reading GROUP BY 1,2,3;

-- ---------------------------------------------------------------- Firmware campaigns
CREATE TABLE firmware.campaign (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  device_kind    text NOT NULL,
  site_id        text REFERENCES inventory.site(id),
  target_version text NOT NULL,
  canary_percent int  NOT NULL DEFAULT 2,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','rolled_back')),
  stage          text NOT NULL DEFAULT 'canary',
  progress       int  NOT NULL DEFAULT 0,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Tamper-evident audit log (hash chain)
CREATE TABLE audit.log (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  user_id   uuid,
  username  text NOT NULL,
  action    text NOT NULL,
  resource  text NOT NULL,
  outcome   text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash bytea,
  hash      bytea NOT NULL
);
