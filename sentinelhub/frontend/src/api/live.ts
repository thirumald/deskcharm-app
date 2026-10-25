import { HubConnectionBuilder, HubConnectionState, LogLevel } from "@microsoft/signalr";
import type { FeatureCollection } from "geojson";
import {
  ApiError, type Api, type AuditRow, type Campaign, type CampaignInput, type CameraHit, type Decision, type Device,
  type EventItem, type HealthSummary, type LatestReading, type LiveHandlers, type Me, type Reading, type RolesPayload,
  type Session, type Site, type StreamGrant, type Track,
} from "./types";

const TOKEN_KEY = "sentinel.token";
const safeGet = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
const safeSet = (v: string | null) => { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };

/** Talks to the .NET backend (REST + SignalR). */
export class LiveApi implements Api {
  readonly mode = "live" as const;
  private token: string | null = safeGet();
  constructor(private base: string) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...init?.headers },
    });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
    return body as T;
  }

  async login(username: string, password: string, mfaCode?: string): Promise<Session> {
    const s = await this.req<Session>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password, mfaCode: mfaCode || null }) });
    this.token = s.token; safeSet(s.token);
    return s;
  }
  logout() { this.token = null; safeSet(null); }
  hasToken() { return this.token != null; }

  me() { return this.req<Me>("/api/auth/me"); }
  sites() { return this.req<Site[]>("/api/sites"); }
  devices() { return this.req<Device[]>("/api/devices"); }
  health() { return this.req<HealthSummary>("/api/health/summary"); }
  events() { return this.req<EventItem[]>("/api/events?limit=100"); }
  ackEvent(id: string) { return this.req<void>(`/api/events/${id}/ack`, { method: "POST" }); }
  cameras() { return this.req<FeatureCollection>("/api/geo/cameras"); }
  fov() { return this.req<FeatureCollection>("/api/geo/fov"); }
  geofences() { return this.req<FeatureCollection>("/api/geo/geofences"); }
  nearestCameras(lon: number, lat: number, n = 5) { return this.req<CameraHit[]>(`/api/geo/nearest-cameras?lon=${lon}&lat=${lat}&n=${n}`); }
  telemetryLatest() { return this.req<LatestReading[]>("/api/telemetry/latest"); }
  roles() { return this.req<RolesPayload>("/api/rbac/roles"); }
  evaluate(permission: string, path: string) {
    return this.req<Decision>(`/api/rbac/evaluate?permission=${encodeURIComponent(permission)}&path=${encodeURIComponent(path)}`);
  }
  campaigns() { return this.req<Campaign[]>("/api/firmware/campaigns"); }
  async createCampaign(input: CampaignInput) { await this.req("/api/firmware/campaigns", { method: "POST", body: JSON.stringify(input) }); }
  audit() { return this.req<AuditRow[]>("/api/audit"); }
  streamToken(deviceId: string, tier = "T2") {
    return this.req<StreamGrant>(`/api/streams/${deviceId}/token`, { method: "POST", body: JSON.stringify({ tier }) });
  }

  connectLive(h: LiveHandlers): () => void {
    const conn = new HubConnectionBuilder()
      .withUrl(`${this.base}/hubs/live`, { accessTokenFactory: () => this.token ?? "" })
      .withAutomaticReconnect([0, 1000, 3000, 5000, 10000])
      .configureLogging(LogLevel.Warning)
      .build();
    conn.on("tracks", (m: { siteId: string; tracks: Track[] }) => h.onTracks(m.siteId, m.tracks.map((t) => ({ ...t, siteId: m.siteId }))));
    conn.on("event", (e: EventItem) => h.onEvent(e));
    conn.on("telemetry", (m: { siteId: string; readings: Reading[] }) => h.onTelemetry(m.siteId, m.readings));
    conn.on("deviceStatus", (m: { deviceId: string; status: Device["status"] }) => h.onDeviceStatus(m.deviceId, m.status));
    conn.onreconnecting(() => h.onState("reconnecting"));
    conn.onreconnected(() => h.onState("live"));
    conn.onclose(() => h.onState("closed"));
    h.onState("connecting");
    conn.start().then(() => h.onState("live")).catch(() => h.onState("closed"));
    return () => { if (conn.state !== HubConnectionState.Disconnected) void conn.stop(); };
  }
}
