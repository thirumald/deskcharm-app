import type { FeatureCollection } from "geojson";

export type Severity = "info" | "warning" | "major" | "critical";
export type DeviceKind = "camera" | "radar" | "iot_gateway" | "sensor";
export type DeviceStatus = "pending" | "provisioned" | "active" | "offline" | "maintenance" | "decommissioned";

export interface Site {
  id: string; name: string; kind: "edge" | "main"; nodePath: string;
  lon: number; lat: number; wanMbps: number; status: string;
}

export interface Device {
  id: string; siteId: string; kind: DeviceKind; name: string; vendor: string; model: string; firmware: string;
  status: DeviceStatus; ip?: string | null; heading: number; nodePath: string; lon: number; lat: number;
  certSerial?: string | null; certExpires?: string | null; lastSeen?: string | null;
  attrs: Record<string, unknown>;
}

export interface EventItem {
  id: string; ts: string; siteId: string; deviceId?: string | null; nodePath: string;
  severity: Severity; kind: string; message: string; state: "new" | "ack" | "closed";
  ackBy?: string | null; ackAt?: string | null; lon?: number | null; lat?: number | null;
}

export interface Track { trackId: string; class: string; lon: number; lat: number; heading: number; speed: number; siteId: string }
export interface Reading { deviceId: string; metric: string; value: number }
export interface LatestReading { deviceId: string; name: string; siteId: string; metric: string; value: number; ts: string }

export interface GrantInfo { roleId: string; nodePath: string; deny: boolean; expiresAtUtc?: string | null }
export interface Me {
  id: string; username: string; displayName: string; agency: string; mfa: boolean;
  permissions: string[]; stepUpPermissions: string[]; grants: GrantInfo[];
}
export interface Session { token: string; expiresAt: string; mfa: boolean; user: { id: string; username: string; displayName: string; agency: string } }

export interface HealthSummary {
  devices: { siteId: string; kind: DeviceKind; status: DeviceStatus; count: number }[];
  alarms: { severity: Severity; state: string; count: number }[];
}

export interface RoleInfo { id: string; name: string; tier: number; description: string; permissions: string[] }
export interface RolesPayload { permissions: string[]; mfaRequired: string[]; roles: RoleInfo[] }
export interface Decision { allowed: boolean; reason: string }

export interface Campaign {
  id: string; name: string; deviceKind: string; siteId?: string | null; targetVersion: string;
  canaryPercent: number; status: "running" | "completed" | "rolled_back"; stage: string; progress: number;
  createdBy: string; createdAt: string;
}
export interface CampaignInput { name: string; deviceKind: string; siteId?: string | null; targetVersion: string; canaryPercent?: number }

export interface AuditRow { id: number; ts: string; username: string; action: string; resource: string; outcome: string; hash: string }
export interface CameraHit { id: string; name: string; siteId: string; meters: number }
export interface StreamGrant { token: string; expiresAt: string; tier: string; path: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface LiveHandlers {
  onTracks(siteId: string, tracks: Track[]): void;
  onEvent(e: EventItem): void;
  onTelemetry(siteId: string, readings: Reading[]): void;
  onDeviceStatus(deviceId: string, status: DeviceStatus): void;
  onState(state: "connecting" | "live" | "reconnecting" | "closed"): void;
}

export interface Api {
  readonly mode: "mock" | "live";
  login(username: string, password: string, mfaCode?: string): Promise<Session>;
  me(): Promise<Me>;
  sites(): Promise<Site[]>;
  devices(): Promise<Device[]>;
  health(): Promise<HealthSummary>;
  events(): Promise<EventItem[]>;
  ackEvent(id: string): Promise<void>;
  cameras(): Promise<FeatureCollection>;
  fov(): Promise<FeatureCollection>;
  geofences(): Promise<FeatureCollection>;
  nearestCameras(lon: number, lat: number, n?: number): Promise<CameraHit[]>;
  telemetryLatest(): Promise<LatestReading[]>;
  roles(): Promise<RolesPayload>;
  evaluate(permission: string, path: string): Promise<Decision>;
  campaigns(): Promise<Campaign[]>;
  createCampaign(input: CampaignInput): Promise<void>;
  audit(): Promise<AuditRow[]>;
  streamToken(deviceId: string, tier?: string): Promise<StreamGrant>;
  connectLive(handlers: LiveHandlers): () => void;
  logout(): void;
}

export const SEVERITY_ORDER: Severity[] = ["critical", "major", "warning", "info"];
