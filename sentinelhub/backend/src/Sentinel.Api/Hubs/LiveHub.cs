using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Sentinel.Api.Services;

namespace Sentinel.Api.Hubs;

/// <summary>
/// Real-time push (radar tracks, events, telemetry). Each connection joins one group per site it may view,
/// so RBAC is enforced at subscription time and the broadcaster never needs per-user logic.
/// </summary>
[Authorize]
public sealed class LiveHub(AccessService access) : Hub
{
    public static string Group(string siteId) => $"site:{siteId}";

    public override async Task OnConnectedAsync()
    {
        var sites = await access.ReachableSiteIdsAsync(Context.User!, "geo.view");
        foreach (var s in sites) await Groups.AddToGroupAsync(Context.ConnectionId, Group(s));
        await base.OnConnectedAsync();
    }
}
