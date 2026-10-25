using System.Security.Claims;
using Sentinel.Api.Auth;
using Sentinel.Api.Data;
using Sentinel.Api.Services;

namespace Sentinel.Api.Endpoints;

public record StreamTokenRequest(string? Tier);

public static class OpsEndpoints
{
    private sealed class SeriesPoint { public DateTime Bucket { get; set; } public double Avg { get; set; } public double Min { get; set; } public double Max { get; set; } }
    private sealed class LatestReading
    {
        public Guid DeviceId { get; set; }
        public string Name { get; set; } = "";
        public string SiteId { get; set; } = "";
        public string Metric { get; set; } = "";
        public double Value { get; set; }
        public DateTime Ts { get; set; }
    }

    public static void MapOps(this RouteGroupBuilder api)
    {
        // ---- events / alarms
        api.MapGet("/events", async (string? state, int? limit, ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.AnyScopeAsync(user, "health.view", "alarm.handle");
            var rows = await db.QueryAsync<EventRow>($@"
                SELECT {EventRow.Select} FROM ops.event e
                WHERE {Db.ScopeSql("e.node_path")} AND (@state::text IS NULL OR e.state = @state)
                ORDER BY e.ts DESC LIMIT @limit",
                new { allow = scope.Allow, deny = scope.Deny, state, limit = Math.Clamp(limit ?? 100, 1, 500) });
            return Results.Ok(rows);
        });

        api.MapPost("/events/{id:guid}/ack", async (Guid id, ClaimsPrincipal user, AccessService access, Db db, AuditService audit) =>
        {
            var path = await db.ScalarAsync<string>("SELECT node_path::text FROM ops.event WHERE id = @id", new { id });
            if (path is null) return Results.NotFound();
            var decision = await access.EvaluateAsync(user, "alarm.handle", path);
            if (!decision.Allowed)
            {
                await audit.WriteAsync(user, "alarm.ack", path, "denied", new { decision.Reason });
                return Helpers.Forbidden(decision);
            }
            await db.ExecuteAsync("UPDATE ops.event SET state = 'ack', ack_by = @by, ack_at = now() WHERE id = @id AND state = 'new'",
                new { id, by = user.Username() });
            await audit.WriteAsync(user, "alarm.ack", path, "allowed", new { id });
            return Results.NoContent();
        });

        // ---- GIS (PostGIS)
        api.MapGet("/geo/cameras", async (ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "geo.view");
            var json = await db.ScalarAsync<string>($@"
                SELECT jsonb_build_object('type','FeatureCollection','features', COALESCE(jsonb_agg(jsonb_build_object(
                  'type','Feature','id',d.id,'geometry',ST_AsGeoJSON(d.geom)::jsonb,
                  'properties',jsonb_build_object('id',d.id,'name',d.name,'kind',d.kind,'status',d.status,'siteId',d.site_id,'heading',d.heading))),'[]'::jsonb))::text
                FROM inventory.device d WHERE d.kind IN ('camera','radar','sensor') AND {Db.ScopeSql("d.node_path")}", scope.Args());
            return Results.Content(json ?? "{}", "application/geo+json");
        });

        api.MapGet("/geo/fov", async (ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "geo.view");
            var json = await db.ScalarAsync<string>($@"
                SELECT jsonb_build_object('type','FeatureCollection','features', COALESCE(jsonb_agg(jsonb_build_object(
                  'type','Feature','geometry',ST_AsGeoJSON(f.fov)::jsonb,
                  'properties',jsonb_build_object('id',d.id,'status',d.status,'siteId',d.site_id))),'[]'::jsonb))::text
                FROM geo.camera_fov f JOIN inventory.device d ON d.id = f.device_id WHERE {Db.ScopeSql("d.node_path")}", scope.Args());
            return Results.Content(json ?? "{}", "application/geo+json");
        });

        api.MapGet("/geo/geofences", async (ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "geo.view");
            var json = await db.ScalarAsync<string>($@"
                SELECT jsonb_build_object('type','FeatureCollection','features', COALESCE(jsonb_agg(jsonb_build_object(
                  'type','Feature','geometry',ST_AsGeoJSON(g.geom)::jsonb,
                  'properties',jsonb_build_object('id',g.id,'name',g.name,'siteId',g.site_id,'restricted',g.restricted))),'[]'::jsonb))::text
                FROM geo.geofence g JOIN inventory.site s ON s.id = g.site_id WHERE {Db.ScopeSql("s.node_path")}", scope.Args());
            return Results.Content(json ?? "{}", "application/geo+json");
        });

        // Latest position per radar track (last 10 s). Live updates arrive over SignalR; this seeds the map on load.
        api.MapGet("/geo/tracks/live", async (ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "geo.view");
            var json = await db.ScalarAsync<string>($@"
                SELECT jsonb_build_object('type','FeatureCollection','features', COALESCE(jsonb_agg(x.f),'[]'::jsonb))::text FROM (
                  SELECT DISTINCT ON (t.track_id) jsonb_build_object('type','Feature','geometry',ST_AsGeoJSON(t.geom)::jsonb,
                    'properties',jsonb_build_object('trackId',t.track_id,'class',t.class,'speed',t.speed,'heading',t.heading,'siteId',d.site_id,'ts',t.ts)) AS f
                  FROM track.track_point t JOIN inventory.device d ON d.id = t.radar_id
                  WHERE t.ts > now() - interval '10 seconds' AND {Db.ScopeSql("d.node_path")}
                  ORDER BY t.track_id, t.ts DESC) x", scope.Args());
            return Results.Content(json ?? "{}", "application/geo+json");
        });

        api.MapGet("/geo/tracks/{trackId}/trail", async (string trackId, int? minutes, ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "geo.view");
            var json = await db.ScalarAsync<string>($@"
                SELECT ST_AsGeoJSON(ST_MakeLine(t.geom ORDER BY t.ts))::text
                FROM track.track_point t JOIN inventory.device d ON d.id = t.radar_id
                WHERE t.track_id = @trackId AND t.ts > now() - make_interval(mins => @minutes) AND {Db.ScopeSql("d.node_path")}
                HAVING count(*) > 1",
                new { allow = scope.Allow, deny = scope.Deny, trackId, minutes = Math.Clamp(minutes ?? 5, 1, 60) });
            return json is null ? Results.NoContent() : Results.Content(json, "application/geo+json");
        });

        // KNN: the N cameras closest to a point (GiST <-> operator)
        api.MapGet("/geo/nearest-cameras", async (double lon, double lat, int? n, ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "video.live");
            return Results.Ok(await db.QueryAsync<CameraHit>($@"
                SELECT d.id, d.name, d.site_id, ST_DistanceSphere(d.geom, q.p) AS meters
                FROM inventory.device d, (SELECT ST_SetSRID(ST_MakePoint(@lon, @lat), 4326) AS p) q
                WHERE d.kind = 'camera' AND {Db.ScopeSql("d.node_path")}
                ORDER BY d.geom <-> q.p LIMIT @n",
                new { allow = scope.Allow, deny = scope.Deny, lon, lat, n = Math.Clamp(n ?? 5, 1, 25) }));
        });

        // Which cameras actually see this point (field-of-view polygon containment)
        api.MapGet("/geo/covering", async (double lon, double lat, ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "video.live");
            return Results.Ok(await db.QueryAsync<CameraHit>($@"
                SELECT d.id, d.name, d.site_id, ST_DistanceSphere(d.geom, q.p) AS meters
                FROM geo.camera_fov f JOIN inventory.device d ON d.id = f.device_id,
                     (SELECT ST_SetSRID(ST_MakePoint(@lon, @lat), 4326) AS p) q
                WHERE ST_Contains(f.fov, q.p) AND d.status = 'active' AND {Db.ScopeSql("d.node_path")}
                ORDER BY meters",
                new { allow = scope.Allow, deny = scope.Deny, lon, lat }));
        });

        // Mapbox Vector Tiles straight from PostGIS (ST_AsMVT). RBAC is applied inside the tile query.
        api.MapGet("/tiles/{z:int}/{x:int}/{y:int}.pbf", async (int z, int x, int y, ClaimsPrincipal user, AccessService access, Db db) =>
        {
            if (z is < 0 or > 22) return Results.BadRequest();
            var scope = await access.ScopeAsync(user, "geo.view");
            var bytes = await db.ScalarAsync<byte[]>($@"
                WITH b AS (SELECT ST_TileEnvelope(@z, @x, @y) AS env),
                cams AS (
                  SELECT d.id::text AS id, d.name, d.kind, d.status, d.site_id AS ""siteId"", d.heading,
                         ST_AsMVTGeom(ST_Transform(d.geom, 3857), b.env, 4096, 64, true) AS geom
                  FROM inventory.device d, b
                  WHERE d.kind IN ('camera','radar') AND ST_Transform(d.geom, 3857) && b.env AND {Db.ScopeSql("d.node_path")}),
                fovs AS (
                  SELECT d.id::text AS id, d.status, ST_AsMVTGeom(ST_Transform(f.fov, 3857), b.env, 4096, 64, true) AS geom
                  FROM geo.camera_fov f JOIN inventory.device d ON d.id = f.device_id, b
                  WHERE ST_Transform(f.fov, 3857) && b.env AND {Db.ScopeSql("d.node_path")}),
                fences AS (
                  SELECT g.id, g.name, g.restricted, ST_AsMVTGeom(ST_Transform(g.geom, 3857), b.env, 4096, 64, true) AS geom
                  FROM geo.geofence g JOIN inventory.site s ON s.id = g.site_id, b
                  WHERE ST_Transform(g.geom, 3857) && b.env AND {Db.ScopeSql("s.node_path")})
                SELECT COALESCE((SELECT ST_AsMVT(cams.*, 'devices', 4096, 'geom') FROM cams), ''::bytea)
                    || COALESCE((SELECT ST_AsMVT(fovs.*, 'fov', 4096, 'geom') FROM fovs), ''::bytea)
                    || COALESCE((SELECT ST_AsMVT(fences.*, 'geofences', 4096, 'geom') FROM fences), ''::bytea)",
                new { allow = scope.Allow, deny = scope.Deny, z, x, y });
            return Results.File(bytes ?? Array.Empty<byte>(), "application/vnd.mapbox-vector-tile");
        });

        // ---- telemetry (Timescale hypertable + continuous aggregate)
        api.MapGet("/telemetry/series", async (Guid deviceId, string metric, int? minutes, ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var path = await db.ScalarAsync<string>("SELECT node_path::text FROM inventory.device WHERE id = @deviceId", new { deviceId });
            if (path is null) return Results.NotFound();
            var decision = await access.EvaluateAsync(user, "telemetry.view", path);
            if (!decision.Allowed) return Helpers.Forbidden(decision);
            return Results.Ok(await db.QueryAsync<SeriesPoint>(@"
                SELECT bucket, avg, min, max FROM telemetry.reading_1m
                WHERE device_id = @deviceId AND metric = @metric AND bucket > now() - make_interval(mins => @minutes)
                ORDER BY bucket", new { deviceId, metric, minutes = Math.Clamp(minutes ?? 60, 1, 1440) }));
        });

        api.MapGet("/telemetry/latest", async (string? siteId, ClaimsPrincipal user, AccessService access, Db db) =>
        {
            var scope = await access.ScopeAsync(user, "telemetry.view");
            return Results.Ok(await db.QueryAsync<LatestReading>($@"
                SELECT DISTINCT ON (r.device_id, r.metric) r.device_id, d.name, d.site_id, r.metric, r.value, r.ts
                FROM telemetry.reading r JOIN inventory.device d ON d.id = r.device_id
                WHERE r.ts > now() - interval '5 minutes' AND {Db.ScopeSql("d.node_path")} AND (@siteId::text IS NULL OR d.site_id = @siteId)
                ORDER BY r.device_id, r.metric, r.ts DESC",
                new { allow = scope.Allow, deny = scope.Deny, siteId }));
        });

        // ---- media: RBAC is enforced when the stream token is issued; the media gateway only validates the signed token.
        api.MapPost("/streams/{deviceId:guid}/token", async (Guid deviceId, StreamTokenRequest? req, ClaimsPrincipal user,
            AccessService access, Db db, TokenService tokens, AuditService audit) =>
        {
            var path = await db.ScalarAsync<string>("SELECT node_path::text FROM inventory.device WHERE id = @deviceId AND kind = 'camera'", new { deviceId });
            if (path is null) return Results.NotFound();
            var decision = await access.EvaluateAsync(user, "video.live", path);
            if (!decision.Allowed)
            {
                await audit.WriteAsync(user, "video.live", path, "denied", new { decision.Reason });
                return Helpers.Forbidden(decision);
            }
            var tier = req?.Tier is "T1" or "T2" or "T3" ? req.Tier : "T2";
            var (token, exp) = tokens.IssueStreamToken(user.UserId(), deviceId, tier);
            return Results.Ok(new { token, expiresAt = exp, tier, path });
        });
    }
}

public class CameraHit
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string SiteId { get; set; } = "";
    public double Meters { get; set; }
}
