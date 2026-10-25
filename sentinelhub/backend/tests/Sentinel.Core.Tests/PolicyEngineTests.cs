using Sentinel.Core.Rbac;
using Xunit;

namespace Sentinel.Core.Tests;

public class PolicyEngineTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private static PolicyEngine Engine() => new(new Dictionary<string, IReadOnlySet<string>>
    {
        ["operator"] = new HashSet<string> { "video.live", "video.ptz", "geo.view" },
        ["supervisor"] = new HashSet<string> { "video.live", "video.export" },
    });

    [Fact]
    public void Grant_on_ancestor_is_inherited_by_descendants()
    {
        var grants = new[] { new Grant("operator", "sentinel.west.portgate", false) };
        Assert.True(Engine().Can(grants, "video.live", "sentinel.west.portgate.cam001", false, Now));
    }

    [Fact]
    public void Grant_does_not_leak_to_sibling_with_shared_prefix()
    {
        var grants = new[] { new Grant("operator", "sentinel.west.port", false) };
        Assert.False(Engine().Can(grants, "video.live", "sentinel.west.portgate.cam001", false, Now));
    }

    [Fact]
    public void Explicit_deny_overrides_inherited_allow()
    {
        var grants = new[]
        {
            new Grant("operator", "sentinel.west.portgate", false),
            new Grant("operator", "sentinel.west.portgate.cam007", true),
        };
        var e = Engine();
        Assert.False(e.Can(grants, "video.live", "sentinel.west.portgate.cam007", false, Now));
        Assert.True(e.Can(grants, "video.live", "sentinel.west.portgate.cam008", false, Now));
    }

    [Fact]
    public void Permission_outside_the_role_is_denied()
    {
        var grants = new[] { new Grant("operator", "sentinel", false) };
        Assert.False(Engine().Can(grants, "video.export", "sentinel.west.portgate", true, Now));
    }

    [Fact]
    public void Mfa_sensitive_permission_requires_step_up()
    {
        var grants = new[] { new Grant("supervisor", "sentinel", false) };
        var e = Engine();
        Assert.False(e.Can(grants, "video.export", "sentinel.west.portgate", false, Now));
        Assert.True(e.Can(grants, "video.export", "sentinel.west.portgate", true, Now));
    }

    [Fact]
    public void Expired_grants_are_ignored()
    {
        var grants = new[] { new Grant("operator", "sentinel", false, Now.AddMinutes(-1)) };
        Assert.False(Engine().Can(grants, "video.live", "sentinel.west.portgate", false, Now));
    }

    [Fact]
    public void Scope_lists_allow_and_deny_subtrees()
    {
        var grants = new[]
        {
            new Grant("operator", "sentinel.west.portgate", false),
            new Grant("operator", "sentinel.west.portgate.cam007", true),
            new Grant("supervisor", "sentinel.west.airport", false),
        };
        var scope = Engine().ScopeFor(grants, "video.live", false, Now);
        Assert.Equal(new[] { "sentinel.west.portgate", "sentinel.west.airport" }, scope.Allow);
        Assert.Equal(new[] { "sentinel.west.portgate.cam007" }, scope.Deny);
    }
}
