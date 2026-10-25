import { useEffect, useState } from "react";
import { api, type AuditRow, type Decision, type RolesPayload } from "../api";
import { Badge, Panel, fmtTime } from "../components/ui";
import { can, useStore } from "../state/store";

export function Access() {
  const { me, devices, sites } = useStore();
  const [roles, setRoles] = useState<RolesPayload | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [perm, setPerm] = useState("video.live");
  const [path, setPath] = useState("sentinel.west.portgate.cam007");
  const [result, setResult] = useState<Decision | null>(null);

  useEffect(() => { api.roles().then(setRoles).catch(() => {}); }, []);
  useEffect(() => {
    if (!can(me, "audit.read")) return;
    let live = true;
    const load = () => api.audit().then((a) => live && setAudit(a)).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => { live = false; clearInterval(t); };
  }, [me]);

  const paths = [...sites.map((s) => s.nodePath), ...devices.slice(0, 60).map((d) => d.nodePath)];

  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="grid two" style={{ alignItems: "start" }}>
        <Panel title="My access">
          <div className="row wrap" style={{ marginBottom: 8 }}>
            <b>{me?.displayName}</b> <span className="muted">{me?.agency}</span> {me?.mfa ? <Badge kind="active">MFA session</Badge> : <Badge kind="warning">No MFA</Badge>}
          </div>
          <table>
            <thead><tr><th>Role</th><th>Node</th><th>Effect</th></tr></thead>
            <tbody>
              {me?.grants.map((g, i) => <tr key={i}><td>{g.roleId}</td><td className="mono">{g.nodePath}</td><td><Badge kind={g.deny ? "deny" : "allow"}>{g.deny ? "deny" : "allow"}</Badge></td></tr>)}
            </tbody>
          </table>
          <div className="panel-title" style={{ marginTop: 12 }}>Effective permissions</div>
          <div className="chips">
            {me?.permissions.map((p) => <span key={p} className="chip">{p}</span>)}
            {me?.stepUpPermissions.map((p) => <span key={p} className="chip" style={{ color: "var(--amber)", borderColor: "rgba(245,158,11,.4)" }} title="Requires MFA step-up">{p} ◆</span>)}
          </div>
        </Panel>

        <Panel title="Policy decision simulator">
          <div className="grid">
            <label>Permission<select value={perm} onChange={(e) => setPerm(e.target.value)}>{(roles?.permissions ?? []).map((p) => <option key={p}>{p}</option>)}</select></label>
            <label>Resource node (ltree path)<input list="paths" value={path} onChange={(e) => setPath(e.target.value)} className="mono" /></label>
            <datalist id="paths">{paths.map((p) => <option key={p} value={p} />)}</datalist>
            <button className="btn primary" onClick={async () => setResult(await api.evaluate(perm, path))}>Evaluate</button>
            {result && <div className="row"><Badge kind={result.allowed ? "allow" : "deny"}>{result.allowed ? "allowed" : "denied"}</Badge><span className="muted">{result.reason}</span></div>}
            <div className="faint">Deny overrides allow; grants inherit down the site → device tree. Try the operator on <span className="mono">…portgate.cam007</span>.</div>
          </div>
        </Panel>
      </div>

      <Panel title="Role × permission matrix" actions={<span className="faint">◆ = requires MFA step-up</span>}>
        <div className="scroll">
          <table className="matrix">
            <thead><tr><th>Permission</th>{roles?.roles.map((r) => <th key={r.id} title={r.description}>T{r.tier}<br /><span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{r.name.split(" ")[0]}</span></th>)}</tr></thead>
            <tbody>
              {roles?.permissions.map((p) => (
                <tr key={p}>
                  <td className="mono">{p}{roles.mfaRequired.includes(p) && <span className="cell-mfa"> ◆</span>}</td>
                  {roles.roles.map((r) => <td key={r.id} className={r.permissions.includes(p) ? (roles.mfaRequired.includes(p) ? "cell-mfa" : "cell-yes") : "cell-no"}>{r.permissions.includes(p) ? "✔" : "·"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {can(me, "audit.read") && (
        <Panel title="Audit log (hash-chained)">
          <div className="scroll" style={{ maxHeight: 280 }}>
            <table>
              <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Resource</th><th>Outcome</th><th>Hash</th></tr></thead>
              <tbody>
                {audit.slice(0, 60).map((a) => (
                  <tr key={a.id}><td className="num">{fmtTime(a.ts)}</td><td>{a.username}</td><td>{a.action}</td><td className="mono">{a.resource}</td><td><Badge kind={a.outcome === "allowed" ? "allow" : "deny"}>{a.outcome}</Badge></td><td className="mono faint">{a.hash.slice(0, 12)}…</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
