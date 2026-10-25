import type { Device, EventItem, Site } from "../api/types";
import type { Grant, RoleMap } from "../rbac/engine";

// Deterministic PRNG so the demo looks the same on every load.
export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SITES: Site[] = [
  { id: "hq", name: "Main DC - Command Center", kind: "main", nodePath: "sentinel.hq", lon: 72.8777, lat: 19.076, wanMbps: 0, status: "online" },
  { id: "portgate", name: "Port Gate Alpha", kind: "edge", nodePath: "sentinel.west.portgate", lon: 72.95, lat: 18.949, wanMbps: 6.4, status: "online" },
  { id: "airport", name: "Airport Terminal 2", kind: "edge", nodePath: "sentinel.west.airport", lon: 72.8656, lat: 19.0896, wanMbps: 7.1, status: "online" },
  { id: "metro", name: "Metro Hub Central", kind: "edge", nodePath: "sentinel.west.metro", lon: 72.8562, lat: 19.0176, wanMbps: 5.9, status: "online" },
  { id: "refinery", name: "Refinery Complex", kind: "edge", nodePath: "sentinel.west.refinery", lon: 72.8997, lat: 19.0522, wanMbps: 5.2, status: "online" },
  { id: "toll", name: "Highway Toll Plaza", kind: "edge", nodePath: "sentinel.west.toll", lon: 72.9998, lat: 19.158, wanMbps: 4.8, status: "online" },
];

const VENDORS = ["Axis", "Hanwha", "Bosch", "Hikvision"];
const MODELS = ["Q6135-LE", "XNP-9300RW", "MIC-7100", "DS-2DF9C"];
const FW = ["11.9.60", "2.21.1", "8.9.3"];
const METRICS = ["temperature_c", "vibration_mm_s", "power_kw", "humidity_pct", "door_open", "smoke_ppm"];

export function buildDevices(): Device[] {
  const rnd = mulberry32(42);
  const out: Device[] = [];
  const now = Date.now();
  for (const s of SITES.filter((x) => x.kind === "edge")) {
    for (let i = 1; i <= 24; i++) {
      const lbl = `cam${String(i).padStart(3, "0")}`;
      out.push({
        id: `${s.id}-${lbl}`, siteId: s.id, kind: "camera", name: `${s.id.toUpperCase()}-${lbl}`,
        vendor: VENDORS[i % 4], model: MODELS[i % 4], firmware: FW[i % 3],
        status: i % 17 === 0 ? "offline" : "active", ip: `10.${10 + (s.id.charCodeAt(0) % 40)}.1.${10 + i}`,
        heading: (i * 37) % 360, nodePath: `${s.nodePath}.${lbl}`,
        lon: s.lon + (((i - 1) % 6) - 2.5) * 0.0009, lat: s.lat + (Math.floor((i - 1) / 6) - 1.5) * 0.0009,
        certSerial: "SN" + Math.floor(rnd() * 1e12).toString(16).toUpperCase().padStart(12, "0"),
        certExpires: new Date(now + (90 - i) * 86400_000).toISOString(), lastSeen: new Date(now).toISOString(),
        attrs: { codec: i % 5 === 0 ? "H.264" : "H.265", resolution: i % 3 === 0 ? "8MP" : "4MP", bitrateKbps: 2800 + (i % 4) * 400, ptz: i % 4 === 0 },
      });
    }
    for (let i = 1; i <= 2; i++) {
      out.push({
        id: `${s.id}-radar${i}`, siteId: s.id, kind: "radar", name: `${s.id.toUpperCase()}-RDR${i}`, vendor: "Axis", model: "D2110-VE",
        firmware: "1.4.2", status: "active", ip: `10.${10 + (s.id.charCodeAt(0) % 40)}.2.${10 + i}`, heading: 0,
        nodePath: `${s.nodePath}.radar${i}`, lon: s.lon + (i * 2 - 3) * 0.003, lat: s.lat + 0.0028,
        certSerial: null, certExpires: null, lastSeen: new Date(now).toISOString(), attrs: { protocol: "ASTERIX Cat 048", rangeM: 350 },
      });
    }
    out.push({
      id: `${s.id}-gw1`, siteId: s.id, kind: "iot_gateway", name: `${s.id.toUpperCase()}-GW1`, vendor: "Advantech", model: "WISE-6610",
      firmware: "3.2.0", status: "active", ip: `10.${10 + (s.id.charCodeAt(0) % 40)}.3.10`, heading: 0, nodePath: `${s.nodePath}.gw1`,
      lon: s.lon, lat: s.lat, certSerial: null, certExpires: null, lastSeen: new Date(now).toISOString(), attrs: {},
    });
    for (let i = 1; i <= 6; i++) {
      out.push({
        id: `${s.id}-sns${i}`, siteId: s.id, kind: "sensor", name: `${s.id.toUpperCase()}-SNS${i}`, vendor: "Generic", model: "MQTT-SENSOR",
        firmware: "1.0.3", status: "active", ip: null, heading: 0, nodePath: `${s.nodePath}.sns${i}`,
        lon: s.lon + (i - 3.5) * 0.0007, lat: s.lat - 0.003, certSerial: null, certExpires: null,
        lastSeen: new Date(now).toISOString(), attrs: { metric: METRICS[i - 1] },
      });
    }
  }
  return out;
}

export function buildEvents(devices: Device[]): EventItem[] {
  const rnd = mulberry32(7);
  const cams = devices.filter((d) => d.kind === "camera");
  const sev = ["info", "warning", "major", "critical"] as const;
  const kinds = ["motion", "tamper", "intrusion", "device_offline"];
  const msgs = ["Motion detected", "Camera tamper suspected", "Perimeter intrusion", "Camera went offline"];
  return Array.from({ length: 8 }, (_, n) => {
    const d = cams[Math.floor(rnd() * cams.length)];
    return {
      id: `evt-seed-${n}`, ts: new Date(Date.now() - (n + 1) * 60_000).toISOString(), siteId: d.siteId, deviceId: d.id,
      nodePath: d.nodePath, severity: sev[(n + 1) % 4], kind: kinds[(n + 1) % 4], message: msgs[(n + 1) % 4],
      state: "new" as const, lon: d.lon, lat: d.lat,
    };
  });
}

// ---- RBAC seed (mirrors db/init/002_seed.sql)
export const ROLES = [
  { id: "super_admin", name: "Platform Super-Admin", tier: 0, description: "Vendor / central IT" },
  { id: "policy_admin", name: "Security / Policy Admin", tier: 1, description: "CISO office" },
  { id: "agency_admin", name: "Agency Administrator", tier: 2, description: "Agency IT lead" },
  { id: "site_admin", name: "Site Administrator", tier: 3, description: "Site engineer" },
  { id: "supervisor", name: "Supervisor / Incident Cmdr", tier: 4, description: "Control room supervisor" },
  { id: "operator", name: "Operator", tier: 5, description: "Control room operator" },
  { id: "investigator", name: "Investigator / Forensics", tier: 6, description: "Case-scoped analyst" },
  { id: "exec_viewer", name: "Executive Viewer", tier: 7, description: "Leadership dashboards" },
  { id: "auditor", name: "Auditor", tier: 8, description: "Read-only compliance" },
  { id: "service_account", name: "Service / Integration Account", tier: 9, description: "Third-party systems" },
];

const V = ["video.live", "video.ptz", "video.playback", "video.export", "video.unmask", "alarm.handle", "geo.view", "telemetry.view"];
export const ROLE_PERMS: RoleMap = {
  super_admin: [...V, "rules.edit", "device.create", "device.configure", "firmware.campaign", "cert.manage", "user.manage", "policy.manage", "storage.policy", "wall.control", "health.view", "audit.read", "breakglass"],
  policy_admin: ["cert.manage", "user.manage", "policy.manage", "storage.policy", "health.view", "audit.read"],
  agency_admin: [...V, "rules.edit", "device.create", "device.configure", "firmware.campaign", "cert.manage", "user.manage", "storage.policy", "wall.control", "health.view", "audit.read", "breakglass"],
  site_admin: ["video.live", "video.ptz", "video.playback", "video.export", "alarm.handle", "geo.view", "telemetry.view", "rules.edit", "device.create", "device.configure", "firmware.campaign", "cert.manage", "user.manage", "storage.policy", "wall.control", "health.view", "audit.read", "breakglass"],
  supervisor: [...V, "rules.edit", "wall.control", "health.view", "breakglass"],
  operator: ["video.live", "video.ptz", "video.playback", "alarm.handle", "geo.view", "telemetry.view", "wall.control", "health.view"],
  investigator: ["video.live", "video.playback", "video.export", "video.unmask", "alarm.handle", "geo.view", "telemetry.view"],
  exec_viewer: ["video.live", "geo.view", "telemetry.view", "wall.control", "health.view"],
  auditor: ["health.view", "audit.read"],
  service_account: ["video.live", "video.playback", "alarm.handle", "geo.view", "telemetry.view", "device.create", "device.configure", "health.view"],
};

export interface MockUser { id: string; username: string; displayName: string; agency: string; grants: Grant[] }
const g = (roleId: string, nodePath: string, deny = false): Grant => ({ roleId, nodePath, deny });
export const USERS: MockUser[] = [
  { id: "u1", username: "admin", displayName: "Priya Nair (Super-Admin)", agency: "Central IT", grants: [g("super_admin", "sentinel")] },
  { id: "u2", username: "policy", displayName: "Rahul Mehta (Policy Admin)", agency: "CISO Office", grants: [g("policy_admin", "sentinel")] },
  { id: "u3", username: "agencyadmin", displayName: "Anita Rao (Agency Admin)", agency: "Agency A", grants: [g("agency_admin", "sentinel")] },
  { id: "u4", username: "siteadmin", displayName: "Karan Shah (Port Site Admin)", agency: "Agency A", grants: [g("site_admin", "sentinel.west.portgate")] },
  { id: "u5", username: "supervisor", displayName: "Meera Iyer (Supervisor)", agency: "Agency A", grants: [g("supervisor", "sentinel")] },
  { id: "u6", username: "operator", displayName: "Vikram Patil (Operator)", agency: "Agency A", grants: [g("operator", "sentinel.west.portgate"), g("operator", "sentinel.west.airport"), g("operator", "sentinel.west.portgate.cam007", true)] },
  { id: "u7", username: "investigator", displayName: "Sana Khan (Investigator)", agency: "Agency A", grants: [g("investigator", "sentinel.west.metro"), g("investigator", "sentinel.west.refinery")] },
  { id: "u8", username: "exec", displayName: "Director Sharma (Exec Viewer)", agency: "Leadership", grants: [g("exec_viewer", "sentinel")] },
  { id: "u9", username: "auditor", displayName: "Neha Joshi (Auditor)", agency: "Compliance", grants: [g("auditor", "sentinel")] },
];

export const DEMO_PASSWORD = "Sentinel!2026";
export const DEMO_MFA = "246810";
