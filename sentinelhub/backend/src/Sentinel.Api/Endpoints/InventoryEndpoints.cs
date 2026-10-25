using System.Security.Claims;
using System.Text.RegularExpressions;
using Sentinel.Api.Auth;
using Sentinel.Api.Data;
using Sentinel.Api.Services;

namespace Sentinel.Api.Endpoints;

public record CreateDeviceRequest(string SiteId, string Kind, string Name, string? Vendor, string? Model, string? Ip,
    double Lon, double Lat, double? Heading);
public record ProvisionRequest(string CsrPem);
public record CampaignRequest(string Name, string DeviceKind, string? SiteId, string TargetVersion, int? CanaryPercent);

public static class InventoryEndpoints
{
    private sealed class DeviceStat { public string SiteId { get; set; } = ""; public string Kind { get; set; } = ""; public string Status { get; set; } = ""; public int Count { get; set; } }
    private sealed class AlarmStat { public string Severity { get; set; } = ""; public string State { get; set; } = ""; public int Count { get; set; } }

    public static void MapInventory(this RouteGroupBuilder api)
    {
        api.MapGet("/sites", async (ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var ids = (await access.ReachableSiteIdsAsync(user, "geo.view"))
                .Union(await access.ReachableSiteIdsAsync(user, "health.view")).ToArray();
            var rows = await db.QueryAsync<SiteRow>(@"
                SELECT id, name, kind, node_path::text AS node_path, ST_X(geom) AS lon, ST_Y(geom) AS lat, wan_mbps, status
                FROM inventory.site WHERE id = ANY(@ids) ORDER BY kind DESC, name", new { ids });
            return Results.Ok(rows);
        });

        api.MapGet("/health/summary", async (ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.AnyScopeAsync(user, "health.view");
            var devices = await db.QueryAsync<DeviceStat>($@"
                SELECT d.site_id, d.kind, d.status, count(*)::int AS count FROM inventory.device d
                WHERE {Db.ScopeSql("d.node_path")} GROUP BY 1,2,3", scope.Args());
            var alarms = await db.QueryAsync<AlarmStat>($@"
                SELECT e.severity, e.state, count(*)::int AS count FROM ops.event e
                WHERE e.ts > now() - interval '24 hours' AND {Db.ScopeSql("e.node_path")} GROUP BY 1,2", scope.Args());
            return Results.Ok(new { devices, alarms });
        });

        api.MapGet("/devices", async (string? siteId, string? kind, ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "geo.view");
            var rows = await db.QueryAsync<DeviceRow>($@"
                SELECT {DeviceRow.Select} FROM inventory.device d
                WHERE {Db.ScopeSql("d.node_path")}
                  AND (@siteId::text IS NULL OR d.site_id = @siteId) AND (@kind::text IS NULL OR d.kind = @kind)
                ORDER BY d.site_id, d.kind, d.name", new { allow = scope.Allow, deny = scope.Deny, siteId, kind });
            return Results.Ok(rows.Select(r => r.ToDto()));
        });

        api.MapPost("/devices", async (CreateDeviceRequest req, ClaimsPrincipal user, AccessService access, Db db, AuditService audit) =>
        {
            var sitePath = await db.ScalarAsync<string>("SELECT node_path::text FROM inventory.site WHERE id = @id", new { id = req.SiteId });
            if (sitePath is null) return Results.NotFound(new { error = "unknown site" });
            var decision = await access.EvaluateAsync(user, "device.create", sitePath);
            if (!decision.Allowed)
            {
                await audit.WriteAsync(user, "device.create", sitePath, "denied", new { decision.Reason });
                return Helpers.Forbidden(decision);
            }
            if (req.Kind is not ("camera" or "radar" or "iot_gateway" or "sensor")) return Results.BadRequest(new { error = "invalid kind" });

            var label = Regex.Replace(req.Name.ToLowerInvariant(), "[^a-z0-9]+", "_").Trim('_');
            label = (label.Length == 0 ? "dev" : label[..Math.Min(label.Length, 24)]) + "_" + Guid.NewGuid().ToString("N")[..4];
            var id = await db.ScalarAsync<Guid>(@"
                INSERT INTO inventory.device (site_id, kind, name, vendor, model, status, ip, heading, node_path, geom)
                VALUES (@SiteId, @Kind, @Name, COALESCE(@Vendor,''), COALESCE(@Model,''), 'pending', @Ip::inet, COALESCE(@Heading,0),
                        (@sitePath || '.' || @label)::ltree, ST_SetSRID(ST_MakePoint(@Lon, @Lat), 4326))
                RETURNING id",
                new { req.SiteId, req.Kind, req.Name, req.Vendor, req.Model, req.Ip, req.Heading, req.Lon, req.Lat, sitePath, label });
            if (req.Kind == "camera")
            {
                await db.ExecuteAsync(@"
                    INSERT INTO geo.camera_fov (device_id, fov)
                    SELECT d.id, ST_SetSRID(ST_MakePolygon(ST_MakeLine(ARRAY[
                        d.geom, ST_Project(d.geom::geography, 70, radians(d.heading - 30))::geometry,
                        ST_Project(d.geom::geography, 78, radians(d.heading))::geometry,
                        ST_Project(d.geom::geography, 70, radians(d.heading + 30))::geometry, d.geom])), 4326)
                    FROM inventory.device d WHERE d.id = @id", new { id });
            }
            await audit.WriteAsync(user, "device.create", $"{sitePath}.{label}", "allowed", new { id, req.Kind, req.Name });
            return Results.Created($"/api/devices/{id}", new { id, nodePath = $"{sitePath}.{label}", status = "pending" });
        });

        // Zero-touch provisioning: device (or its bootstrap agent) submits a PKCS#10 CSR and receives an operational certificate.
        api.MapPost("/devices/{id:guid}/provision", async (Guid id, ProvisionRequest req, ClaimsPrincipal user,
            AccessService access, Db db, DevCa ca, AuditService audit) =>
        {
            var path = await db.ScalarAsync<string>("SELECT node_path::text FROM inventory.device WHERE id = @id", new { id });
            if (path is null) return Results.NotFound();
            var decision = await access.EvaluateAsync(user, "device.configure", path);
            if (!decision.Allowed)
            {
                await audit.WriteAsync(user, "device.provision", path, "denied", new { decision.Reason });
                return Helpers.Forbidden(decision);
            }
            try
            {
                var (pem, serial, notAfter) = ca.IssueFromCsr(req.CsrPem, id);
                await db.ExecuteAsync(@"UPDATE inventory.device SET status = 'active', cert_serial = @serial, cert_expires = @notAfter,
                                         last_seen = now() WHERE id = @id", new { serial, notAfter, id });
                await audit.WriteAsync(user, "device.provision", path, "allowed", new { serial });
                return Results.Ok(new { certificatePem = pem, caPem = ca.CaPem, serial, notAfter });
            }
            catch (System.Security.Cryptography.CryptographicException)
            {
                return Results.BadRequest(new { error = "invalid CSR" });
            }
        });

        api.MapGet("/pki/ca", (DevCa ca) => Results.Text(ca.CaPem, "application/x-pem-file")).AllowAnonymous();

        // ---- mass firmware campaigns (staged canary rollout, advanced by FirmwareWorker)
        api.MapGet("/firmware/campaigns", async (ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var sites = (await access.ReachableSiteIdsAsync(user, "health.view")).ToArray();
            if (sites.Length == 0) return Results.Ok(Array.Empty<CampaignRow>());
            return Results.Ok(await db.QueryAsync<CampaignRow>(@"
                SELECT id, name, device_kind, site_id, target_version, canary_percent, status, stage, progress, created_by, created_at
                FROM firmware.campaign WHERE site_id IS NULL OR site_id = ANY(@sites) ORDER BY created_at DESC LIMIT 50", new { sites }));
        });

        api.MapPost("/firmware/campaigns", async (CampaignRequest req, ClaimsPrincipal user, AccessService access, Db db, AuditService audit) =>
        {
            var path = "sentinel";
            if (req.SiteId is not null)
            {
                path = await db.ScalarAsync<string>("SELECT node_path::text FROM inventory.site WHERE id = @id", new { id = req.SiteId }) ?? "";
                if (path.Length == 0) return Results.NotFound(new { error = "unknown site" });
            }
            var decision = await access.EvaluateAsync(user, "firmware.campaign", path);
            if (!decision.Allowed)
            {
                await audit.WriteAsync(user, "firmware.campaign", path, "denied", new { decision.Reason });
                return Helpers.Forbidden(decision);
            }
            var id = await db.ScalarAsync<Guid>(@"
                INSERT INTO firmware.campaign (name, device_kind, site_id, target_version, canary_percent, created_by)
                VALUES (@Name, @DeviceKind, @SiteId, @TargetVersion, COALESCE(@CanaryPercent, 2), @by) RETURNING id",
                new { req.Name, req.DeviceKind, req.SiteId, req.TargetVersion, req.CanaryPercent, by = user.Username() });
            await audit.WriteAsync(user, "firmware.campaign", path, "allowed", new { id, req.TargetVersion });
            return Results.Created($"/api/firmware/campaigns/{id}", new { id });
        });

        api.MapGet("/audit", async (ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var decision = await access.EvaluateAsync(user, "audit.read", "sentinel");
            if (!decision.Allowed) return Helpers.Forbidden(decision);
            return Results.Ok(await db.QueryAsync<AuditRow>(@"
                SELECT id, ts, username, action, resource, outcome, encode(hash, 'hex') AS hash
                FROM audit.log ORDER BY id DESC LIMIT 200"));
        });
    }
}
