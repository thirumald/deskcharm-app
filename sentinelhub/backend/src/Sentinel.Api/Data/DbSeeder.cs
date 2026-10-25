using Sentinel.Api.Auth;

namespace Sentinel.Api.Data;

/// <summary>Waits for PostgreSQL and hashes the demo password for seeded local users.</summary>
public sealed class DbSeeder(Db db, IConfiguration config, ILogger<DbSeeder> log) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                var ids = await db.QueryAsync<Guid>("SELECT id FROM iam.app_user WHERE password_hash IS NULL", ct: ct);
                foreach (var id in ids)
                {
                    await db.ExecuteAsync("UPDATE iam.app_user SET password_hash = @h WHERE id = @id",
                        new { h = PasswordHasher.Hash(config["Auth:DemoPassword"]!), id }, ct);
                }
                if (ids.Count > 0) log.LogWarning("Seeded demo password for {Count} local users (dev only).", ids.Count);
                return;
            }
            catch (Exception ex) when (attempt < 30 && !ct.IsCancellationRequested)
            {
                log.LogInformation("Waiting for PostgreSQL ({Attempt}/30): {Message}", attempt, ex.Message);
                await Task.Delay(2000, ct);
            }
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
