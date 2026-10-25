using System.Security.Claims;
using Microsoft.Extensions.Caching.Memory;
using Sentinel.Api.Auth;
using Sentinel.Api.Data;
using Sentinel.Core.Rbac;

namespace Sentinel.Api.Services;

/// <summary>Loads the role→permission table (policy store) from PostgreSQL and caches the engine for a minute.</summary>
public sealed class PolicyStore(Db db, IMemoryCache cache)
{
    private sealed class RolePerm { public string RoleId { get; set; } = ""; public string Permission { get; set; } = ""; }

    public async Task<PolicyEngine> GetAsync()
    {
        if (cache.TryGetValue("policy-engine", out PolicyEngine? cached) && cached is not null) return cached;
        var rows = await db.QueryAsync<RolePerm>("SELECT role_id, permission FROM iam.role_permission");
        var map = rows.GroupBy(r => r.RoleId)
            .ToDictionary(g => g.Key, g => (IReadOnlySet<string>)g.Select(x => x.Permission).ToHashSet());
        var engine = new PolicyEngine(map);
        cache.Set("policy-engine", engine, TimeSpan.FromSeconds(60));
        return engine;
    }
}

/// <summary>Policy Enforcement Point helpers: evaluates the PDP for the current principal.</summary>
public sealed class AccessService(Db db, PolicyStore store, IMemoryCache cache)
{
    public async Task<IReadOnlyList<Grant>> GrantsAsync(Guid userId)
    {
        var key = $"grants:{userId}";
        if (cache.TryGetValue(key, out IReadOnlyList<Grant>? cached) && cached is not null) return cached;
        var rows = await db.QueryAsync<GrantRow>(@"
            SELECT role_id, node_path::text AS node_path, (effect = 'deny') AS deny, expires_at
            FROM iam.grant WHERE user_id = @userId", new { userId });
        var grants = rows.Select(r => new Grant(r.RoleId, r.NodePath, r.Deny, r.ExpiresAt)).ToList();
        cache.Set(key, (IReadOnlyList<Grant>)grants, TimeSpan.FromSeconds(15));
        return grants;
    }

    public async Task<Decision> EvaluateAsync(ClaimsPrincipal user, string permission, string resourcePath)
    {
        var engine = await store.GetAsync();
        var grants = await GrantsAsync(user.UserId());
        return engine.Evaluate(grants, permission, resourcePath, user.HasMfa(), DateTime.UtcNow);
    }

    public async Task<bool> CanAsync(ClaimsPrincipal user, string permission, string resourcePath)
        => (await EvaluateAsync(user, permission, resourcePath)).Allowed;

    public async Task<Scope> ScopeAsync(ClaimsPrincipal user, string permission)
    {
        var engine = await store.GetAsync();
        var grants = await GrantsAsync(user.UserId());
        return engine.ScopeFor(grants, permission, user.HasMfa(), DateTime.UtcNow);
    }

    /// <summary>Sites where the user holds the permission on the site node or on anything beneath it.</summary>
    public async Task<List<string>> ReachableSiteIdsAsync(ClaimsPrincipal user, string permission)
    {
        var scope = await ScopeAsync(user, permission);
        if (scope.Allow.Length == 0) return new List<string>();
        return await db.QueryAsync<string>(@"
            SELECT s.id FROM inventory.site s
            WHERE EXISTS (SELECT 1 FROM unnest(@allow::text[]::ltree[]) a WHERE s.node_path <@ a OR a <@ s.node_path)",
            new { allow = scope.Allow });
    }
}
