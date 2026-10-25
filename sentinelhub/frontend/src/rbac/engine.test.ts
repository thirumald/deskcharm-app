import { describe, expect, it } from "vitest";
import { evaluate, inScope, scopeFor, type Grant } from "./engine";

const roles = { operator: ["video.live", "geo.view"], supervisor: ["video.live", "video.export"] };

describe("policy engine", () => {
  it("inherits grants down the tree but not to look-alike siblings", () => {
    const g: Grant[] = [{ roleId: "operator", nodePath: "s.west.port", deny: false }];
    expect(evaluate(roles, g, "video.live", "s.west.port.cam1", false).allowed).toBe(true);
    expect(evaluate(roles, g, "video.live", "s.west.portgate.cam1", false).allowed).toBe(false);
  });

  it("lets an explicit device-level deny override an inherited allow", () => {
    const g: Grant[] = [
      { roleId: "operator", nodePath: "s.west.portgate", deny: false },
      { roleId: "operator", nodePath: "s.west.portgate.cam007", deny: true },
    ];
    expect(evaluate(roles, g, "video.live", "s.west.portgate.cam007", false).allowed).toBe(false);
    expect(evaluate(roles, g, "video.live", "s.west.portgate.cam008", false).allowed).toBe(true);
  });

  it("requires MFA for sensitive permissions", () => {
    const g: Grant[] = [{ roleId: "supervisor", nodePath: "s", deny: false }];
    expect(evaluate(roles, g, "video.export", "s.a", false).reason).toBe("step-up MFA required");
    expect(evaluate(roles, g, "video.export", "s.a", true).allowed).toBe(true);
  });

  it("ignores expired grants", () => {
    const g: Grant[] = [{ roleId: "operator", nodePath: "s", deny: false, expiresAt: 10 }];
    expect(evaluate(roles, g, "video.live", "s.a", false, 11).allowed).toBe(false);
  });

  it("builds scopes usable for row filtering", () => {
    const g: Grant[] = [
      { roleId: "operator", nodePath: "s.a", deny: false },
      { roleId: "operator", nodePath: "s.a.cam7", deny: true },
    ];
    const scope = scopeFor(roles, g, "video.live", false);
    expect(inScope(scope, "s.a.cam1")).toBe(true);
    expect(inScope(scope, "s.a.cam7")).toBe(false);
    expect(inScope(scope, "s.b.cam1")).toBe(false);
  });
});
