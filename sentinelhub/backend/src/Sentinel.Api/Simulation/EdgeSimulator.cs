using Microsoft.AspNetCore.SignalR;
using Sentinel.Api.Data;
using Sentinel.Api.Hubs;

namespace Sentinel.Api.Simulation;

/// <summary>
/// Stands in for the Edge DC ingestion gateways until real ONVIF / ASTERIX / MQTT adapters are plugged in.
/// It writes the same rows a real gateway would (track points, sensor readings, events) and pushes them over SignalR.
/// </summary>
public sealed class EdgeSimulator(Db db, IHubContext<LiveHub> hub, IConfiguration config, ILogger<EdgeSimulator> log) : BackgroundService
{
    private sealed class RadarRow { public Guid Id { get; set; } public string SiteId { get; set; } = ""; public double Lon { get; set; } public double Lat { get; set; } }
    private sealed class SensorRow { public Guid Id { get; set; } public string SiteId { get; set; } = ""; public string Metric { get; set; } = ""; }
    private sealed class BreachRow { public string TrackId { get; set; } = ""; public string Class { get; set; } = ""; public string SiteId { get; set; } = ""; public string Fence { get; set; } = ""; public Guid RadarId { get; set; } public string NodePath { get; set; } = ""; public double Lon { get; set; } public double Lat { get; set; } }
    private sealed class CamRow { public Guid Id { get; set; } public string Name { get; set; } = ""; public string Status { get; set; } = ""; public string SiteId { get; set; } = ""; public string NodePath { get; set; } = ""; }

    private sealed class SimTrack
    {
        public string Id = ""; public Guid RadarId; public string SiteId = ""; public string Class = "person";
        public double Lon, Lat, Heading, SpeedMs, HomeLon, HomeLat;
    }

    private static readonly Random Rng = new();
    private static readonly string[] Classes = { "person", "vehicle", "vehicle", "person", "drone" };

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!config.GetValue("Simulation:Enabled", true)) return;

        List<RadarRow> radars; List<SensorRow> sensors;
        while (true)
        {
            try
            {
                radars = await db.QueryAsync<RadarRow>(@"SELECT id, site_id, ST_X(geom) AS lon, ST_Y(geom) AS lat FROM inventory.device WHERE kind = 'radar' AND status = 'active'", ct: ct);
                sensors = await db.QueryAsync<SensorRow>(@"SELECT id, site_id, attrs->>'metric' AS metric FROM inventory.device WHERE kind = 'sensor' AND attrs ? 'metric'", ct: ct);
                break;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                log.LogInformation("Simulator waiting for database: {Message}", ex.Message);
                await Task.Delay(3000, ct);
            }
        }

        var tracks = new List<SimTrack>();
        var n = 0;
        foreach (var r in radars)
            for (var i = 0; i < 5; i++)
                tracks.Add(NewTrack(r, ++n));

        var alarmed = new HashSet<string>();
        var tick = 0;
        log.LogInformation("Edge simulator running: {Radars} radars, {Tracks} tracks, {Sensors} sensors", radars.Count, tracks.Count, sensors.Count);

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(ct))
        {
            tick++;
            try
            {
                Advance(tracks);
                await PersistAndBroadcastTracks(tracks, ct);
                await DetectBreaches(alarmed, ct);
                if (tick % 5 == 0) await EmitTelemetry(sensors, ct);
                if (tick % 30 == 0) await FlapRandomCamera(ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                log.LogWarning("Simulator tick failed: {Message}", ex.Message);
            }
        }
    }

    private static SimTrack NewTrack(RadarRow r, int n)
    {
        var cls = Classes[Rng.Next(Classes.Length)];
        var t = new SimTrack
        {
            Id = $"T{n:0000}", RadarId = r.Id, SiteId = r.SiteId, Class = cls,
            HomeLon = r.Lon, HomeLat = r.Lat - 0.0014,
            Heading = Rng.NextDouble() * 360,
            SpeedMs = cls switch { "person" => 1.4, "vehicle" => 8.0, _ => 12.0 },
        };
        t.Lon = t.HomeLon + (Rng.NextDouble() - 0.5) * 0.004;
        t.Lat = t.HomeLat + (Rng.NextDouble() - 0.5) * 0.004;
        return t;
    }

    private static void Advance(List<SimTrack> tracks)
    {
        foreach (var t in tracks)
        {
            t.Heading = (t.Heading + (Rng.NextDouble() - 0.5) * 30 + 360) % 360;
            var rad = t.Heading * Math.PI / 180;
            var metersPerDegLat = 111_320.0;
            var metersPerDegLon = 111_320.0 * Math.Cos(t.Lat * Math.PI / 180);
            t.Lon += Math.Sin(rad) * t.SpeedMs / metersPerDegLon;
            t.Lat += Math.Cos(rad) * t.SpeedMs / metersPerDegLat;
            // Steer back toward the radar's area of interest.
            if (Math.Abs(t.Lon - t.HomeLon) > 0.003 || Math.Abs(t.Lat - t.HomeLat) > 0.003)
                t.Heading = (Math.Atan2(t.HomeLon - t.Lon, t.HomeLat - t.Lat) * 180 / Math.PI + 360) % 360;
        }
    }

    private async Task PersistAndBroadcastTracks(List<SimTrack> tracks, CancellationToken ct)
    {
        await db.ExecuteAsync(@"
            INSERT INTO track.track_point (ts, radar_id, track_id, class, speed, heading, geom)
            SELECT now(), u.r, u.t, u.c, u.s, u.h, ST_SetSRID(ST_MakePoint(u.lo, u.la), 4326)
            FROM unnest(@radar::uuid[], @tid::text[], @cls::text[], @spd::float8[], @hdg::float8[], @lon::float8[], @lat::float8[])
                 AS u(r, t, c, s, h, lo, la)",
            new
            {
                radar = tracks.Select(t => t.RadarId).ToArray(), tid = tracks.Select(t => t.Id).ToArray(),
                cls = tracks.Select(t => t.Class).ToArray(), spd = tracks.Select(t => t.SpeedMs).ToArray(),
                hdg = tracks.Select(t => t.Heading).ToArray(), lon = tracks.Select(t => t.Lon).ToArray(), lat = tracks.Select(t => t.Lat).ToArray(),
            }, ct);

        foreach (var g in tracks.GroupBy(t => t.SiteId))
        {
            await hub.Clients.Group(LiveHub.Group(g.Key)).SendAsync("tracks", new
            {
                siteId = g.Key, ts = DateTime.UtcNow,
                tracks = g.Select(t => new { trackId = t.Id, @class = t.Class, lon = t.Lon, lat = t.Lat, heading = t.Heading, speed = t.SpeedMs }),
            }, ct);
        }
    }

    /// <summary>Radar tracks inside a restricted geofence raise a critical alarm (PostGIS ST_Intersects).</summary>
    private async Task DetectBreaches(HashSet<string> alarmed, CancellationToken ct)
    {
        var inside = await db.QueryAsync<BreachRow>(@"
            SELECT t.track_id, t.class, d.site_id, g.name AS fence, d.id AS radar_id, d.node_path::text AS node_path,
                   ST_X(t.geom) AS lon, ST_Y(t.geom) AS lat
            FROM (SELECT DISTINCT ON (track_id) * FROM track.track_point WHERE ts > now() - interval '2 seconds'
                  ORDER BY track_id, ts DESC) t
            JOIN inventory.device d ON d.id = t.radar_id
            JOIN geo.geofence g ON g.site_id = d.site_id AND g.restricted AND ST_Intersects(g.geom, t.geom)", ct: ct);

        alarmed.IntersectWith(inside.Select(b => b.TrackId));
        foreach (var b in inside.Where(b => alarmed.Add(b.TrackId)))
        {
            await RaiseAsync(b.SiteId, b.RadarId, b.NodePath, "critical", "geofence_breach",
                $"{b.Class} track {b.TrackId} entered {b.Fence}", b.Lon, b.Lat, ct);
        }
    }

    private async Task EmitTelemetry(List<SensorRow> sensors, CancellationToken ct)
    {
        double Value(string m) => m switch
        {
            "temperature_c" => 31 + Rng.NextDouble() * 3,
            "vibration_mm_s" => 2 + Rng.NextDouble() * (Rng.Next(60) == 0 ? 7 : 1.2),
            "power_kw" => 46 + Rng.NextDouble() * 6,
            "humidity_pct" => 60 + Rng.NextDouble() * 8,
            "door_open" => Rng.Next(40) == 0 ? 1 : 0,
            "smoke_ppm" => 3 + Rng.NextDouble() * 2,
            _ => Rng.NextDouble(),
        };
        var readings = sensors.Select(s => (s, v: Value(s.Metric))).ToList();
        await db.ExecuteAsync(@"
            INSERT INTO telemetry.reading (ts, device_id, metric, value)
            SELECT now(), u.d, u.m, u.v FROM unnest(@dev::uuid[], @metric::text[], @val::float8[]) AS u(d, m, v)",
            new { dev = readings.Select(r => r.s.Id).ToArray(), metric = readings.Select(r => r.s.Metric).ToArray(), val = readings.Select(r => r.v).ToArray() }, ct);

        foreach (var g in readings.GroupBy(r => r.s.SiteId))
        {
            await hub.Clients.Group(LiveHub.Group(g.Key)).SendAsync("telemetry", new
            {
                siteId = g.Key, ts = DateTime.UtcNow,
                readings = g.Select(r => new { deviceId = r.s.Id, metric = r.s.Metric, value = r.v }),
            }, ct);
        }
    }

    private async Task FlapRandomCamera(CancellationToken ct)
    {
        var cam = await db.QueryFirstOrDefaultAsync<CamRow>(@"
            SELECT id, name, status, site_id, node_path::text AS node_path FROM inventory.device
            WHERE kind = 'camera' AND status IN ('active','offline') ORDER BY random() LIMIT 1", ct: ct);
        if (cam is null) return;
        var next = cam.Status == "active" ? "offline" : "active";
        await db.ExecuteAsync("UPDATE inventory.device SET status = @next, last_seen = now() WHERE id = @id", new { next, id = cam.Id }, ct);
        if (next == "offline")
            await RaiseAsync(cam.SiteId, cam.Id, cam.NodePath, "major", "device_offline", $"{cam.Name} stopped responding (RTSP keepalive lost)", null, null, ct);
        await hub.Clients.Group(LiveHub.Group(cam.SiteId)).SendAsync("deviceStatus", new { deviceId = cam.Id, status = next }, ct);
    }

    private async Task RaiseAsync(string siteId, Guid deviceId, string nodePath, string severity, string kind, string message,
        double? lon, double? lat, CancellationToken ct)
    {
        var id = await db.ScalarAsync<Guid>(@"
            INSERT INTO ops.event (site_id, device_id, node_path, severity, kind, message, geom)
            VALUES (@siteId, @deviceId, @nodePath::ltree, @severity, @kind, @message,
                    CASE WHEN @lon::float8 IS NULL THEN (SELECT geom FROM inventory.device WHERE id = @deviceId)
                         ELSE ST_SetSRID(ST_MakePoint(@lon, @lat), 4326) END)
            RETURNING id", new { siteId, deviceId, nodePath, severity, kind, message, lon, lat }, ct);
        var ev = await db.QueryFirstOrDefaultAsync<EventRow>($"SELECT {EventRow.Select} FROM ops.event e WHERE e.id = @id", new { id }, ct);
        if (ev is not null) await hub.Clients.Group(LiveHub.Group(siteId)).SendAsync("event", ev, ct);
    }
}
