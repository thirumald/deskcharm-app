import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  ApiError, type Api, type AuditRow, type Campaign, type CampaignInput, type CameraHit, type Decision, type Device,
  type EventItem, type HealthSummary, type LatestReading, type LiveHandlers, type Me, type Reading, type RolesPayload,
  type Session, type Severity, type Site, type StreamGrant, type Track,
} from "../api/types";
import { evaluate, inScope, MFA_REQUIRED, PERMISSIONS, scopeFor, type Grant } from "../rbac/engine";
import { buildDevices, buildEvents, DEMO_MFA, DEMO_PASSWORD, mulberry32, ROLE_PERMS, ROLES, SITES, USERS, type MockUser } from "./data";

const MPD_LAT = 111_320;
const mpdLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let uid = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${++uid}`;

function sector(d: Device): Polygon {
  const pts: [number, number][] = [[d.lon, d.lat]];
  for (const [a, r] of [[-30, 70], [0, 78], [30, 70]] as const) {
    const b = ((d.heading + a) * Math.PI) / 180;
    pts.push([d.lon + (Math.sin(b) * r) / mpdLon(d.lat), d.lat + (Math.cos(b) * r) / MPD_LAT]);
  }
  pts.push([d.lon, d.lat]);
  return { type: "Polygon", coordinates: [pts] };
}

function circle(lon: number, lat: number, radiusM: number): Polygon {
  const ring: [number, number][] = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    ring.push([lon + (Math.cos(a) * radiusM) / mpdLon(lat), lat + (Math.sin(a) * radiusM) / MPD_LAT]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

const fence = (s: Site) => ({ lon: s.lon + 0.0016, lat: s.lat + 0.0012, r: 55 });

const haversine = (lon1: number, lat1: number, lon2: number, lat2: number) => {
  const dx = (lon2 - lon1) * mpdLon((lat1 + lat2) / 2);
  const dy = (lat2 - lat1) * MPD_LAT;
  return Math.hypot(dx, dy);
};

/** Fully in-browser backend: same RBAC rules, same shapes as the .NET API, plus a radar/IoT/event simulator. */
export class MockApi implements Api {
  readonly mode = "mock" as const;
  private devs = buildDevices();
  private evts: EventItem[] = buildEvents(this.devs);
  private camps: Campaign[] = [];
  private auditLog: AuditRow[] = [];
  private user: MockUser | null = null;
  private mfa = false;
  private latest = new Map<string, LatestReading>();

  // ---- helpers
  private need(): MockUser {
    if (!this.user) throw new ApiError(401, "Not signed in");
    return this.user;
  }
  private scope(permission: string) { return scopeFor(ROLE_PERMS, this.need().grants, permission, this.mfa); }
  private can(permission: string, path: string): Decision { return evaluate(ROLE_PERMS, this.need().grants, permission, path, this.mfa); }
  private record(action: string, resource: string, outcome: string) {
    const prev = this.auditLog[0]?.hash ?? "";
    let h = 2166136261;
    for (const c of prev + action + resource + outcome + Date.now()) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const hash = (h >>> 0).toString(16).padStart(8, "0").repeat(8);
    this.auditLog.unshift({ id: this.auditLog.length + 1, ts: new Date().toISOString(), username: this.user?.username ?? "anonymous", action, resource, outcome, hash });
  }
  private siteReachable(s: Site, permission: string): boolean {
    const sc = this.scope(permission);
    return sc.allow.some((a) => s.nodePath === a || s.nodePath.startsWith(a + ".") || a.startsWith(s.nodePath + "."));
  }

  // ---- auth
  async login(username: string, password: string, mfaCode?: string): Promise<Session> {
    await wait(250);
    const u = USERS.find((x) => x.username === username);
    if (!u || password !== DEMO_PASSWORD) {
      this.record("auth.login", "iam", "denied");
      throw new ApiError(401, "Invalid credentials");
    }
    this.user = u;
    this.mfa = mfaCode === DEMO_MFA;
    this.record("auth.login", "iam", "allowed");
    return {
      token: "mock-token", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), mfa: this.mfa,
      user: { id: u.id, username: u.username, displayName: u.displayName, agency: u.agency },
    };
  }
  logout() { this.user = null; this.mfa = false; }

  async me(): Promise<Me> {
    const u = this.need();
    const held = PERMISSIONS.filter((p) => scopeFor(ROLE_PERMS, u.grants, p, this.mfa).allow.length > 0);
    const withMfa = PERMISSIONS.filter((p) => scopeFor(ROLE_PERMS, u.grants, p, true).allow.length > 0);
    return {
      id: u.id, username: u.username, displayName: u.displayName, agency: u.agency, mfa: this.mfa,
      permissions: [...held], stepUpPermissions: withMfa.filter((p) => !held.includes(p)),
      grants: u.grants.map((g: Grant) => ({ roleId: g.roleId, nodePath: g.nodePath, deny: g.deny })),
    };
  }

  // ---- inventory
  async sites(): Promise<Site[]> {
    await wait();
    return SITES.filter((s) => this.siteReachable(s, "geo.view") || this.siteReachable(s, "health.view"));
  }
  async devices(): Promise<Device[]> {
    await wait();
    const sc = this.scope("geo.view");
    return this.devs.filter((d) => inScope(sc, d.nodePath));
  }
  async health(): Promise<HealthSummary> {
    await wait();
    const sc = this.scope("health.view");
    const counts = new Map<string, { siteId: string; kind: Device["kind"]; status: Device["status"]; count: number }>();
    for (const d of this.devs.filter((x) => inScope(sc, x.nodePath))) {
      const k = `${d.siteId}|${d.kind}|${d.status}`;
      const c = counts.get(k) ?? { siteId: d.siteId, kind: d.kind, status: d.status, count: 0 };
      c.count++; counts.set(k, c);
    }
    const al = new Map<string, { severity: Severity; state: string; count: number }>();
    for (const e of this.evts.filter((x) => inScope(sc, x.nodePath))) {
      const k = `${e.severity}|${e.state}`;
      const c = al.get(k) ?? { severity: e.severity, state: e.state, count: 0 };
      c.count++; al.set(k, c);
    }
    return { devices: [...counts.values()], alarms: [...al.values()] };
  }

  // ---- events
  async events(): Promise<EventItem[]> {
    await wait();
    const a = this.scope("health.view"), b = this.scope("alarm.handle");
    return this.evts.filter((e) => inScope(a, e.nodePath) || inScope(b, e.nodePath)).slice(0, 100);
  }
  async ackEvent(id: string): Promise<void> {
    const e = this.evts.find((x) => x.id === id);
    if (!e) throw new ApiError(404, "Not found");
    const d = this.can("alarm.handle", e.nodePath);
    if (!d.allowed) { this.record("alarm.ack", e.nodePath, "denied"); throw new ApiError(403, d.reason); }
    e.state = "ack"; e.ackBy = this.user!.username; e.ackAt = new Date().toISOString();
    this.record("alarm.ack", e.nodePath, "allowed");
  }

  // ---- geo
  async cameras(): Promise<FeatureCollection> {
    const sc = this.scope("geo.view");
    return {
      type: "FeatureCollection",
      features: this.devs.filter((d) => d.kind !== "iot_gateway" && inScope(sc, d.nodePath)).map((d): Feature => ({
        type: "Feature", id: d.id, geometry: { type: "Point", coordinates: [d.lon, d.lat] },
        properties: { id: d.id, name: d.name, kind: d.kind, status: d.status, siteId: d.siteId, heading: d.heading },
      })),
    };
  }
  async fov(): Promise<FeatureCollection> {
    const sc = this.scope("geo.view");
    return {
      type: "FeatureCollection",
      features: this.devs.filter((d) => d.kind === "camera" && inScope(sc, d.nodePath)).map((d): Feature => ({
        type: "Feature", geometry: sector(d), properties: { id: d.id, status: d.status, siteId: d.siteId },
      })),
    };
  }
  async geofences(): Promise<FeatureCollection> {
    return {
      type: "FeatureCollection",
      features: SITES.filter((s) => s.kind === "edge" && this.siteReachable(s, "geo.view")).map((s): Feature => ({
        type: "Feature", geometry: circle(fence(s).lon, fence(s).lat, fence(s).r),
        properties: { name: "Restricted Zone", siteId: s.id, restricted: true },
      })),
    };
  }
  async nearestCameras(lon: number, lat: number, n = 5): Promise<CameraHit[]> {
    const sc = this.scope("video.live");
    return this.devs
      .filter((d) => d.kind === "camera" && inScope(sc, d.nodePath))
      .map((d) => ({ id: d.id, name: d.name, siteId: d.siteId, meters: haversine(lon, lat, d.lon, d.lat) }))
      .sort((a, b) => a.meters - b.meters).slice(0, n);
  }
  async telemetryLatest(): Promise<LatestReading[]> {
    return [...this.latest.values()].filter((r) => {
      const d = this.devs.find((x) => x.id === r.deviceId);
      return d && inScope(this.scope("telemetry.view"), d.nodePath);
    });
  }

  // ---- RBAC / admin
  async roles(): Promise<RolesPayload> {
    await wait();
    return {
      permissions: [...PERMISSIONS], mfaRequired: [...MFA_REQUIRED],
      roles: ROLES.map((r) => ({ ...r, permissions: [...ROLE_PERMS[r.id]].sort() })),
    };
  }
  async evaluate(permission: string, path: string): Promise<Decision> { await wait(); return this.can(permission, path); }

  async campaigns(): Promise<Campaign[]> { return [...this.camps]; }
  async createCampaign(input: CampaignInput): Promise<void> {
    const site = input.siteId ? SITES.find((s) => s.id === input.siteId) : undefined;
    const path = site?.nodePath ?? "sentinel";
    const d = this.can("firmware.campaign", path);
    if (!d.allowed) { this.record("firmware.campaign", path, "denied"); throw new ApiError(403, d.reason); }
    this.camps.unshift({
      id: nextId("camp"), name: input.name, deviceKind: input.deviceKind, siteId: input.siteId ?? null, targetVersion: input.targetVersion,
      canaryPercent: input.canaryPercent ?? 2, status: "running", stage: "canary", progress: 0,
      createdBy: this.user!.username, createdAt: new Date().toISOString(),
    });
    this.record("firmware.campaign", path, "allowed");
  }
  async audit(): Promise<AuditRow[]> {
    const d = this.can("audit.read", "sentinel");
    if (!d.allowed) throw new ApiError(403, d.reason);
    return [...this.auditLog];
  }
  async streamToken(deviceId: string, tier = "T2"): Promise<StreamGrant> {
    const dev = this.devs.find((x) => x.id === deviceId);
    if (!dev) throw new ApiError(404, "Not found");
    const d = this.can("video.live", dev.nodePath);
    if (!d.allowed) throw new ApiError(403, d.reason);
    return { token: "mock-stream-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), tier, path: dev.nodePath };
  }

  // ---- live feed simulator (stands in for the Edge ingestion gateways)
  connectLive(h: LiveHandlers): () => void {
    h.onState("live");
    const rnd = mulberry32(Date.now() & 0xffff);
    const sites = SITES.filter((s) => s.kind === "edge" && this.siteReachable(s, "geo.view"));
    const radars = this.devs.filter((d) => d.kind === "radar" && sites.some((s) => s.id === d.siteId));
    interface T extends Track { home: [number, number]; radarId: string }
    let n = 0;
    const classes = ["person", "vehicle", "vehicle", "person", "drone"];
    const tracks: T[] = radars.flatMap((r) => Array.from({ length: 5 }, () => {
      const cls = classes[Math.floor(rnd() * classes.length)];
      const home: [number, number] = [r.lon, r.lat - 0.0014];
      return {
        trackId: `T${String(++n).padStart(4, "0")}`, class: cls, siteId: r.siteId, radarId: r.id, home,
        lon: home[0] + (rnd() - 0.5) * 0.004, lat: home[1] + (rnd() - 0.5) * 0.004, heading: rnd() * 360,
        speed: cls === "person" ? 1.4 : cls === "vehicle" ? 8 : 12,
      };
    }));
    const alarmed = new Set<string>();

    const raise = (siteId: string, dev: Device | undefined, severity: Severity, kind: string, message: string, lon?: number, lat?: number) => {
      const e: EventItem = {
        id: nextId("evt"), ts: new Date().toISOString(), siteId, deviceId: dev?.id ?? null, nodePath: dev?.nodePath ?? SITES.find((s) => s.id === siteId)!.nodePath,
        severity, kind, message, state: "new", lon: lon ?? dev?.lon ?? null, lat: lat ?? dev?.lat ?? null,
      };
      this.evts.unshift(e);
      h.onEvent(e);
    };

    const tick = setInterval(() => {
      for (const t of tracks) {
        t.heading = (t.heading + (rnd() - 0.5) * 30 + 360) % 360;
        const r = (t.heading * Math.PI) / 180;
        t.lon += (Math.sin(r) * t.speed) / mpdLon(t.lat);
        t.lat += (Math.cos(r) * t.speed) / MPD_LAT;
        if (Math.abs(t.lon - t.home[0]) > 0.003 || Math.abs(t.lat - t.home[1]) > 0.003)
          t.heading = (Math.atan2(t.home[0] - t.lon, t.home[1] - t.lat) * 180 / Math.PI + 360) % 360;
      }
      for (const s of sites) h.onTracks(s.id, tracks.filter((t) => t.siteId === s.id).map(({ trackId, class: c, lon, lat, heading, speed, siteId }) => ({ trackId, class: c, lon, lat, heading, speed, siteId })));
      const inside = new Set<string>();
      for (const t of tracks) {
        const s = SITES.find((x) => x.id === t.siteId)!;
        const f = fence(s);
        if (haversine(t.lon, t.lat, f.lon, f.lat) < f.r) {
          inside.add(t.trackId);
          if (!alarmed.has(t.trackId)) {
            alarmed.add(t.trackId);
            raise(t.siteId, this.devs.find((d) => d.id === t.radarId), "critical", "geofence_breach", `${t.class} track ${t.trackId} entered Restricted Zone`, t.lon, t.lat);
          }
        }
      }
      for (const id of [...alarmed]) if (!inside.has(id)) alarmed.delete(id);
    }, 1000);

    const sensors = this.devs.filter((d) => d.kind === "sensor" && sites.some((s) => s.id === d.siteId));
    const base: Record<string, () => number> = {
      temperature_c: () => 31 + rnd() * 3, vibration_mm_s: () => 2 + rnd() * (rnd() < 0.02 ? 7 : 1.2), power_kw: () => 46 + rnd() * 6,
      humidity_pct: () => 60 + rnd() * 8, door_open: () => (rnd() < 0.025 ? 1 : 0), smoke_ppm: () => 3 + rnd() * 2,
    };
    const emitTelemetry = () => {
      for (const s of sites) {
        const readings: Reading[] = sensors.filter((d) => d.siteId === s.id).map((d) => {
          const metric = String(d.attrs.metric);
          const value = (base[metric] ?? (() => rnd()))();
          this.latest.set(`${d.id}|${metric}`, { deviceId: d.id, name: d.name, siteId: d.siteId, metric, value, ts: new Date().toISOString() });
          return { deviceId: d.id, metric, value };
        });
        h.onTelemetry(s.id, readings);
      }
    };
    emitTelemetry();
    const tele = setInterval(emitTelemetry, 3000);

    const flap = setInterval(() => {
      const cams = this.devs.filter((d) => d.kind === "camera" && sites.some((s) => s.id === d.siteId));
      const cam = cams[Math.floor(rnd() * cams.length)];
      if (!cam) return;
      cam.status = cam.status === "active" ? "offline" : "active";
      h.onDeviceStatus(cam.id, cam.status);
      if (cam.status === "offline") raise(cam.siteId, cam, "major", "device_offline", `${cam.name} stopped responding (RTSP keepalive lost)`);
    }, 25_000);

    const fw = setInterval(() => {
      for (const c of this.camps.filter((x) => x.status === "running")) {
        c.progress = Math.min(100, c.progress + 8);
        c.stage = c.progress < 10 ? "canary" : c.progress < 50 ? "wave2" : "full";
        if (c.progress >= 100) {
          c.status = "completed";
          for (const d of this.devs) if (d.kind === c.deviceKind && (!c.siteId || d.siteId === c.siteId)) d.firmware = c.targetVersion;
        }
      }
    }, 3000);

    return () => { clearInterval(tick); clearInterval(tele); clearInterval(flap); clearInterval(fw); h.onState("closed"); };
  }
}
