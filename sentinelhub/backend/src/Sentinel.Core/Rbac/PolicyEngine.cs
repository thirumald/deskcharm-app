namespace Sentinel.Core.Rbac;

/// <summary>One (user, role) binding on a node of the resource tree. Deny overrides allow.</summary>
public sealed record Grant(string RoleId, string NodePath, bool Deny, DateTime? ExpiresAtUtc = null);

public sealed record Decision(bool Allowed, string Reason);

/// <summary>Allowed and denied subtrees for one permission, suitable for pushing into SQL (ltree &lt;@ ANY).</summary>
public sealed record Scope(string[] Allow, string[] Deny)
{
    public static readonly Scope None = new(Array.Empty<string>(), Array.Empty<string>());
}

public static class Permissions
{
    public static readonly string[] All =
    {
        "video.live", "video.ptz", "video.playback", "video.export", "video.unmask", "alarm.handle",
        "geo.view", "telemetry.view", "rules.edit", "device.create", "device.configure", "firmware.campaign",
        "cert.manage", "user.manage", "policy.manage", "storage.policy", "wall.control", "health.view",
        "audit.read", "breakglass",
    };

    /// <summary>Actions that need a step-up (MFA) session on top of the grant.</summary>
    public static readonly IReadOnlySet<string> MfaRequired = new HashSet<string>
    {
        "video.export", "video.unmask", "firmware.campaign", "cert.manage", "policy.manage", "user.manage", "breakglass",
    };
}

/// <summary>
/// Hybrid RBAC/ABAC policy decision point. Pure and side-effect free so it can be unit tested and
/// used identically by the API (PEP), the SignalR hub and the SQL scope generator.
/// </summary>
public sealed class PolicyEngine
{
    private readonly IReadOnlyDictionary<string, IReadOnlySet<string>> _rolePermissions;

    public PolicyEngine(IReadOnlyDictionary<string, IReadOnlySet<string>> rolePermissions)
        => _rolePermissions = rolePermissions;

    /// <summary>True when <paramref name="grantPath"/> equals or is an ancestor of <paramref name="resourcePath"/>.</summary>
    public static bool Covers(string grantPath, string resourcePath) =>
        string.Equals(grantPath, resourcePath, StringComparison.OrdinalIgnoreCase)
        || resourcePath.StartsWith(grantPath + ".", StringComparison.OrdinalIgnoreCase);

    private bool RoleHas(string roleId, string permission) =>
        _rolePermissions.TryGetValue(roleId, out var perms) && perms.Contains(permission);

    public Decision Evaluate(IEnumerable<Grant> grants, string permission, string resourcePath, bool mfa, DateTime nowUtc)
    {
        var allowed = false;
        foreach (var g in grants)
        {
            if (g.ExpiresAtUtc is { } exp && exp <= nowUtc) continue;
            if (!Covers(g.NodePath, resourcePath)) continue;
            if (!RoleHas(g.RoleId, permission)) continue;
            if (g.Deny) return new Decision(false, $"explicit deny on {g.NodePath}");
            allowed = true;
        }

        if (!allowed) return new Decision(false, "no grant covers this resource");
        if (Permissions.MfaRequired.Contains(permission) && !mfa) return new Decision(false, "step-up MFA required");
        return new Decision(true, "allowed");
    }

    public bool Can(IEnumerable<Grant> grants, string permission, string resourcePath, bool mfa, DateTime nowUtc)
        => Evaluate(grants, permission, resourcePath, mfa, nowUtc).Allowed;

    /// <summary>Every permission the subject holds on one resource.</summary>
    public IReadOnlyList<string> Effective(IReadOnlyCollection<Grant> grants, string resourcePath, bool mfa, DateTime nowUtc)
        => Permissions.All.Where(p => Can(grants, p, resourcePath, mfa, nowUtc)).ToList();

    /// <summary>Subtrees where the permission is granted / explicitly denied; used for row-level filtering in SQL.</summary>
    public Scope ScopeFor(IEnumerable<Grant> grants, string permission, bool mfa, DateTime nowUtc)
    {
        if (Permissions.MfaRequired.Contains(permission) && !mfa) return Scope.None;
        var allow = new List<string>();
        var deny = new List<string>();
        foreach (var g in grants)
        {
            if (g.ExpiresAtUtc is { } exp && exp <= nowUtc) continue;
            if (!RoleHas(g.RoleId, permission)) continue;
            (g.Deny ? deny : allow).Add(g.NodePath);
        }
        return new Scope(allow.Distinct().ToArray(), deny.Distinct().ToArray());
    }
}
