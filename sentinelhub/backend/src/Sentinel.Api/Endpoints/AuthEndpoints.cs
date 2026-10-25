using System.Security.Claims;
using Sentinel.Api.Auth;
using Sentinel.Api.Data;
using Sentinel.Api.Services;
using Sentinel.Core.Rbac;

namespace Sentinel.Api.Endpoints;

public record LoginRequest(string Username, string Password, string? MfaCode);

public static class AuthEndpoints
{
    private sealed class RoleRow { public string Id { get; set; } = ""; public string Name { get; set; } = ""; public int Tier { get; set; } public string Description { get; set; } = ""; }
    private sealed class RolePermRow { public string RoleId { get; set; } = ""; public string Permission { get; set; } = ""; }

    public static void MapAuth(this RouteGroupBuilder api)
    {
        api.MapPost("/auth/login", async (LoginRequest req, Db db, TokenService tokens, AuditService audit, IConfiguration cfg) =>
        {
            var user = await db.QueryFirstOrDefaultAsync<UserRow>(
                "SELECT id, username, display_name, agency, password_hash, enabled FROM iam.app_user WHERE username = @u",
                new { u = req.Username });

            // Always run a hash verification so unknown users and wrong passwords cost the same.
            var ok = PasswordHasher.Verify(req.Password, user?.PasswordHash) && user is { Enabled: true };
            if (!ok)
            {
                await audit.WriteAsync(null, req.Username, "auth.login", "iam", "denied");
                return Results.Json(new { error = "Invalid credentials" }, statusCode: 401);
            }

            var mfa = !string.IsNullOrEmpty(req.MfaCode) && req.MfaCode == cfg["Auth:DemoMfaCode"]; // TODO: TOTP / WebAuthn / IdP amr claim
            var (token, exp) = tokens.Issue(user!.Id, user.Username, user.DisplayName, user.Agency, mfa);
            await audit.WriteAsync(user.Id, user.Username, "auth.login", "iam", "allowed", new { mfa });
            return Results.Ok(new { token, expiresAt = exp, mfa, user = new { user.Id, user.Username, user.DisplayName, user.Agency } });
        }).AllowAnonymous();

        api.MapGet("/auth/me", async (ClaimsPrincipal principal, AccessService access, PolicyStore store) =>
        {
            var engine = await store.GetAsync();
            var grants = await access.GrantsAsync(principal.UserId());
            var now = DateTime.UtcNow;
            var mfa = principal.HasMfa();
            var held = Permissions.All.Where(p => engine.ScopeFor(grants, p, mfa, now).Allow.Length > 0).ToList();
            var withMfa = Permissions.All.Where(p => engine.ScopeFor(grants, p, true, now).Allow.Length > 0).ToList();
            return Results.Ok(new
            {
                id = principal.UserId(),
                username = principal.Username(),
                displayName = principal.FindFirstValue("name"),
                agency = principal.FindFirstValue("agency"),
                mfa,
                permissions = held,
                stepUpPermissions = withMfa.Except(held).ToList(),
                grants = grants.Select(g => new { g.RoleId, g.NodePath, g.Deny, g.ExpiresAtUtc }),
            });
        });

        // ---- RBAC console
        api.MapGet("/rbac/roles", async (Db db) =>
        {
            var roles = await db.QueryAsync<RoleRow>("SELECT id, name, tier, description FROM iam.role ORDER BY tier");
            var perms = await db.QueryAsync<RolePermRow>("SELECT role_id, permission FROM iam.role_permission");
            return Results.Ok(new
            {
                permissions = Permissions.All,
                mfaRequired = Permissions.MfaRequired,
                roles = roles.Select(r => new
                {
                    r.Id, r.Name, r.Tier, r.Description,
                    permissions = perms.Where(p => p.RoleId == r.Id).Select(p => p.Permission).OrderBy(p => p).ToList(),
                }),
            });
        });

        // Effective-permission simulator: "can <user> do <permission> on <path>, and why?"
        api.MapGet("/rbac/evaluate", async (string permission, string path, Guid? userId, ClaimsPrincipal principal,
            AccessService access, PolicyStore store) =>
        {
            if (userId is { } other && other != principal.UserId())
            {
                var gate = await access.EvaluateAsync(principal, "policy.manage", "sentinel");
                if (!gate.Allowed) return Helpers.Forbidden(gate);
                var engine = await store.GetAsync();
                var grants = await access.GrantsAsync(other);
                return Results.Ok(engine.Evaluate(grants, permission, path, mfa: true, DateTime.UtcNow));
            }
            return Results.Ok(await access.EvaluateAsync(principal, permission, path));
        });
    }
}
