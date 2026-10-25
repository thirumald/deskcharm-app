// Client-side port of Sentinel.Core.Rbac.PolicyEngine. Used by the offline simulator; in live mode the server decides.
export interface Grant { roleId: string; nodePath: string; deny: boolean; expiresAt?: number | null }
export interface Decision { allowed: boolean; reason: string }
export interface Scope { allow: string[]; deny: string[] }

export const PERMISSIONS = [
  "video.live", "video.ptz", "video.playback", "video.export", "video.unmask", "alarm.handle",
  "geo.view", "telemetry.view", "rules.edit", "device.create", "device.configure", "firmware.campaign",
  "cert.manage", "user.manage", "policy.manage", "storage.policy", "wall.control", "health.view",
  "audit.read", "breakglass",
] as const;

export const MFA_REQUIRED = new Set([
  "video.export", "video.unmask", "firmware.campaign", "cert.manage", "policy.manage", "user.manage", "breakglass",
]);

export const covers = (grantPath: string, resourcePath: string): boolean =>
  grantPath === resourcePath || resourcePath.startsWith(grantPath + ".");

export type RoleMap = Record<string, string[]>;

export function evaluate(
  roles: RoleMap, grants: Grant[], permission: string, resourcePath: string, mfa: boolean, now = Date.now(),
): Decision {
  let allowed = false;
  for (const g of grants) {
    if (g.expiresAt != null && g.expiresAt <= now) continue;
    if (!covers(g.nodePath, resourcePath)) continue;
    if (!roles[g.roleId]?.includes(permission)) continue;
    if (g.deny) return { allowed: false, reason: `explicit deny on ${g.nodePath}` };
    allowed = true;
  }
  if (!allowed) return { allowed: false, reason: "no grant covers this resource" };
  if (MFA_REQUIRED.has(permission) && !mfa) return { allowed: false, reason: "step-up MFA required" };
  return { allowed: true, reason: "allowed" };
}

export function scopeFor(roles: RoleMap, grants: Grant[], permission: string, mfa: boolean, now = Date.now()): Scope {
  if (MFA_REQUIRED.has(permission) && !mfa) return { allow: [], deny: [] };
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const g of grants) {
    if (g.expiresAt != null && g.expiresAt <= now) continue;
    if (!roles[g.roleId]?.includes(permission)) continue;
    (g.deny ? deny : allow).add(g.nodePath);
  }
  return { allow: [...allow], deny: [...deny] };
}

export const inScope = (scope: Scope, path: string): boolean =>
  scope.allow.some((a) => covers(a, path)) && !scope.deny.some((d) => covers(d, path));
