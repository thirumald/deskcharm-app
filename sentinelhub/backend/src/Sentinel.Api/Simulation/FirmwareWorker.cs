using Sentinel.Api.Data;

namespace Sentinel.Api.Simulation;

/// <summary>
/// Advances firmware campaigns through canary → wave 2 → full rollout. In production this is where per-device
/// ONVIF / LwM2M update jobs are dispatched and health-checked (auto-rollback on regression).
/// </summary>
public sealed class FirmwareWorker(Db db, IConfiguration config, ILogger<FirmwareWorker> log) : BackgroundService
{
    private sealed class Running { public Guid Id { get; set; } public string DeviceKind { get; set; } = ""; public string? SiteId { get; set; } public string TargetVersion { get; set; } = ""; public int Progress { get; set; } }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!config.GetValue("Simulation:Enabled", true)) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                var running = await db.QueryAsync<Running>(
                    "SELECT id, device_kind, site_id, target_version, progress FROM firmware.campaign WHERE status = 'running'", ct: ct);
                foreach (var c in running)
                {
                    var progress = Math.Min(100, c.Progress + 8);
                    var stage = progress < 10 ? "canary" : progress < 50 ? "wave2" : "full";
                    var status = progress >= 100 ? "completed" : "running";
                    await db.ExecuteAsync("UPDATE firmware.campaign SET progress = @progress, stage = @stage, status = @status WHERE id = @id",
                        new { progress, stage, status, id = c.Id }, ct);
                    if (status == "completed")
                    {
                        var n = await db.ExecuteAsync(@"UPDATE inventory.device SET firmware = @v
                            WHERE kind = @k AND status <> 'decommissioned' AND (@s::text IS NULL OR site_id = @s)",
                            new { v = c.TargetVersion, k = c.DeviceKind, s = c.SiteId }, ct);
                        log.LogInformation("Firmware campaign {Id} completed: {Count} devices on {Version}", c.Id, n, c.TargetVersion);
                    }
                }
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                log.LogWarning("Firmware worker tick failed: {Message}", ex.Message);
            }
        }
    }
}
