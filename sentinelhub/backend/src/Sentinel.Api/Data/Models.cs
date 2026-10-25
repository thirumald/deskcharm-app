using System.Text.Json;

namespace Sentinel.Api.Data;

public class SiteRow
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public string NodePath { get; set; } = "";
    public double Lon { get; set; }
    public double Lat { get; set; }
    public double WanMbps { get; set; }
    public string Status { get; set; } = "";
}

public class DeviceRow
{
    public Guid Id { get; set; }
    public string SiteId { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Name { get; set; } = "";
    public string Vendor { get; set; } = "";
    public string Model { get; set; } = "";
    public string Firmware { get; set; } = "";
    public string Status { get; set; } = "";
    public string? Ip { get; set; }
    public double Heading { get; set; }
    public string NodePath { get; set; } = "";
    public double Lon { get; set; }
    public double Lat { get; set; }
    public string? CertSerial { get; set; }
    public DateTime? CertExpires { get; set; }
    public DateTime? LastSeen { get; set; }
    public string Attrs { get; set; } = "{}";

    public object ToDto() => new
    {
        Id, SiteId, Kind, Name, Vendor, Model, Firmware, Status, Ip, Heading, NodePath, Lon, Lat,
        CertSerial, CertExpires, LastSeen,
        Attrs = JsonDocument.Parse(Attrs).RootElement.Clone(),
    };

    public const string Select = @"
        d.id, d.site_id, d.kind, d.name, d.vendor, d.model, d.firmware, d.status, host(d.ip) AS ip, d.heading,
        d.node_path::text AS node_path, ST_X(d.geom) AS lon, ST_Y(d.geom) AS lat,
        d.cert_serial, d.cert_expires, d.last_seen, d.attrs::text AS attrs";
}

public class EventRow
{
    public Guid Id { get; set; }
    public DateTime Ts { get; set; }
    public string SiteId { get; set; } = "";
    public Guid? DeviceId { get; set; }
    public string NodePath { get; set; } = "";
    public string Severity { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Message { get; set; } = "";
    public string State { get; set; } = "";
    public string? AckBy { get; set; }
    public DateTime? AckAt { get; set; }
    public double? Lon { get; set; }
    public double? Lat { get; set; }

    public const string Select = @"
        e.id, e.ts, e.site_id, e.device_id, e.node_path::text AS node_path, e.severity, e.kind, e.message,
        e.state, e.ack_by, e.ack_at, ST_X(e.geom) AS lon, ST_Y(e.geom) AS lat";
}

public class CampaignRow
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string DeviceKind { get; set; } = "";
    public string? SiteId { get; set; }
    public string TargetVersion { get; set; } = "";
    public int CanaryPercent { get; set; }
    public string Status { get; set; } = "";
    public string Stage { get; set; } = "";
    public int Progress { get; set; }
    public string CreatedBy { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

public class UserRow
{
    public Guid Id { get; set; }
    public string Username { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Agency { get; set; } = "";
    public string? PasswordHash { get; set; }
    public bool Enabled { get; set; }
}

public class GrantRow
{
    public string RoleId { get; set; } = "";
    public string NodePath { get; set; } = "";
    public bool Deny { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

public class AuditRow
{
    public long Id { get; set; }
    public DateTime Ts { get; set; }
    public string Username { get; set; } = "";
    public string Action { get; set; } = "";
    public string Resource { get; set; } = "";
    public string Outcome { get; set; } = "";
    public string Hash { get; set; } = "";
}
