using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Sentinel.Api.Auth;

public sealed class TokenService(IConfiguration config)
{
    public static SymmetricSecurityKey Key(IConfiguration c) =>
        new(Encoding.UTF8.GetBytes(c["Auth:SigningKey"]!));

    public (string Token, DateTime ExpiresAt) Issue(Guid userId, string username, string displayName, string agency, bool mfa)
    {
        var expires = DateTime.UtcNow.AddMinutes(config.GetValue("Auth:TokenMinutes", 15));
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = config["Auth:Issuer"],
            Audience = config["Auth:Audience"],
            Expires = expires,
            SigningCredentials = new SigningCredentials(Key(config), SecurityAlgorithms.HmacSha256),
            Subject = new ClaimsIdentity(new[]
            {
                new Claim("sub", userId.ToString()),
                new Claim("preferred_username", username),
                new Claim("name", displayName),
                new Claim("agency", agency),
                new Claim("mfa", mfa ? "true" : "false"),
            }),
        };
        return (new JsonWebTokenHandler().CreateToken(descriptor), expires);
    }

    /// <summary>Short-lived (60 s) token that a media gateway verifies before opening a stream (RBAC enforced at issue time).</summary>
    public (string Token, DateTime ExpiresAt) IssueStreamToken(Guid userId, Guid deviceId, string tier)
    {
        var expires = DateTime.UtcNow.AddSeconds(60);
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = config["Auth:Issuer"],
            Audience = "sentinelhub-media",
            Expires = expires,
            SigningCredentials = new SigningCredentials(Key(config), SecurityAlgorithms.HmacSha256),
            Subject = new ClaimsIdentity(new[]
            {
                new Claim("sub", userId.ToString()),
                new Claim("dev", deviceId.ToString()),
                new Claim("tier", tier),
            }),
        };
        return (new JsonWebTokenHandler().CreateToken(descriptor), expires);
    }
}

public static class PrincipalExtensions
{
    public static Guid UserId(this ClaimsPrincipal p) => Guid.Parse(p.FindFirstValue("sub")!);
    public static string Username(this ClaimsPrincipal p) => p.FindFirstValue("preferred_username") ?? "unknown";
    public static bool HasMfa(this ClaimsPrincipal p) => p.FindFirstValue("mfa") == "true";
}
