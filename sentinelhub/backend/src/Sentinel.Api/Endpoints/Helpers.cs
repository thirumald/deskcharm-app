using System.Security.Claims;
using Sentinel.Api.Services;
using Sentinel.Core.Rbac;

namespace Sentinel.Api.Endpoints;

public static class Helpers
{
    public static IResult Forbidden(Decision d) => Results.Json(new { error = d.Reason }, statusCode: StatusCodes.Status403Forbidden);

    /// <summary>Union of the scopes of several permissions (e.g. a list visible to anyone who can view health or handle alarms).</summary>
    public static async Task<Scope> AnyScopeAsync(this AccessService access, ClaimsPrincipal user, params string[] permissions)
    {
        var allow = new HashSet<string>();
        var deny = new HashSet<string>();
        foreach (var p in permissions)
        {
            var s = await access.ScopeAsync(user, p);
            allow.UnionWith(s.Allow);
            deny.UnionWith(s.Deny);
        }
        return new Scope(allow.ToArray(), deny.ToArray());
    }

    public static object Args(this Scope s) => new { allow = s.Allow, deny = s.Deny };
}
