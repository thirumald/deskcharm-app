using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Sentinel.Api.Auth;
using Sentinel.Api.Data;

namespace Sentinel.Api.Services;

/// <summary>Append-only audit log; every row hashes the previous one so tampering is detectable.</summary>
public sealed class AuditService(Db db)
{
    public Task WriteAsync(ClaimsPrincipal user, string action, string resource, string outcome, object? detail = null)
        => WriteAsync(user.Identity?.IsAuthenticated == true ? user.UserId() : null, user.Identity?.IsAuthenticated == true ? user.Username() : "anonymous",
            action, resource, outcome, detail);

    public async Task WriteAsync(Guid? userId, string username, string action, string resource, string outcome, object? detail = null)
    {
        await using var conn = await db.Source.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(7001)", transaction: tx);
        var prev = await conn.ExecuteScalarAsync<byte[]?>("SELECT hash FROM audit.log ORDER BY id DESC LIMIT 1", transaction: tx);
        var ts = DateTime.UtcNow;
        var json = JsonSerializer.Serialize(detail ?? new { });
        var payload = Encoding.UTF8.GetBytes($"{ts:O}|{userId}|{username}|{action}|{resource}|{outcome}|{json}");
        var hash = SHA256.HashData((prev ?? Array.Empty<byte>()).Concat(payload).ToArray());
        await conn.ExecuteAsync(@"
            INSERT INTO audit.log (ts, user_id, username, action, resource, outcome, detail, prev_hash, hash)
            VALUES (@ts, @userId, @username, @action, @resource, @outcome, @json::jsonb, @prev, @hash)",
            new { ts, userId, username, action, resource, outcome, json, prev, hash }, tx);
        await tx.CommitAsync();
    }
}
