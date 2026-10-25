import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Campaign } from "../api";
import { Badge, Panel, fmtDate } from "../components/ui";
import { can, useStore } from "../state/store";

export function Devices() {
  const { devices, sites, me } = useStore();
  const [q, setQ] = useState("");
  const [site, setSite] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [form, setForm] = useState({ name: "Q3 camera firmware", deviceKind: "camera", siteId: "", targetVersion: "11.10.1" });
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    const load = () => api.campaigns().then((c) => live && setCampaigns(c)).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const rows = useMemo(() => devices.filter((d) =>
    (!site || d.siteId === site) && (!kind || d.kind === kind) && (!status || d.status === status) &&
    (!q || `${d.name} ${d.ip ?? ""} ${d.vendor} ${d.model}`.toLowerCase().includes(q.toLowerCase())),
  ), [devices, q, site, kind, status]);

  const soonExpiring = devices.filter((d) => d.certExpires && new Date(d.certExpires).getTime() - Date.now() < 30 * 86400_000).length;
  const needsMfa = me?.stepUpPermissions.includes("firmware.campaign");

  async function launch(e: FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      await api.createCampaign({ ...form, siteId: form.siteId || null });
      setCampaigns(await api.campaigns());
    } catch (x) { setErr(x instanceof Error ? x.message : "Failed"); }
  }

  return (
    <div className="grid two" style={{ alignItems: "start" }}>
      <Panel title={`Device inventory · ${rows.length} of ${devices.length}`}
        actions={<span className="faint">{soonExpiring} certs expire within 30 d</span>}>
        <div className="row wrap" style={{ marginBottom: 10 }}>
          <input placeholder="Search name / IP / model…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search devices" />
          <select value={site} onChange={(e) => setSite(e.target.value)} aria-label="Site"><option value="">All sites</option>{sites.filter((s) => s.kind === "edge").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind"><option value="">All kinds</option>{["camera", "radar", "iot_gateway", "sensor"].map((k) => <option key={k}>{k}</option>)}</select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option>{["active", "offline", "pending", "maintenance"].map((k) => <option key={k}>{k}</option>)}</select>
        </div>
        <div className="scroll" style={{ maxHeight: "calc(100vh - 230px)" }}>
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Status</th><th>IP</th><th>Model</th><th>Firmware</th><th>Cert expires</th></tr></thead>
            <tbody>
              {rows.slice(0, 300).map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td><td className="muted">{d.kind}</td><td><Badge kind={d.status} /></td>
                  <td className="mono">{d.ip ?? "—"}</td><td>{d.vendor} {d.model}</td><td className="mono">{d.firmware}</td><td className="num">{fmtDate(d.certExpires)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid">
        <Panel title="Mass firmware update">
          <form className="grid" onSubmit={launch}>
            <label>Campaign name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
            <div className="row">
              <label style={{ flex: 1 }}>Device kind
                <select value={form.deviceKind} onChange={(e) => setForm({ ...form, deviceKind: e.target.value })}>{["camera", "radar", "iot_gateway", "sensor"].map((k) => <option key={k}>{k}</option>)}</select>
              </label>
              <label style={{ flex: 1 }}>Scope
                <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">All sites</option>{sites.filter((s) => s.kind === "edge").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </label>
            </div>
            <label>Target version<input value={form.targetVersion} onChange={(e) => setForm({ ...form, targetVersion: e.target.value })} required /></label>
            <div className="faint">Rollout: canary 2% → 10% → 100%, auto-rollback on health regression.</div>
            <button className="btn primary" disabled={!can(me, "firmware.campaign") && !needsMfa}>Launch campaign</button>
            {needsMfa && <div className="muted">Needs a step-up (MFA) session — sign in again with the MFA code.</div>}
            {!can(me, "firmware.campaign") && !needsMfa && <div className="muted">Your role cannot run firmware campaigns.</div>}
            {err && <div className="err" role="alert">{err}</div>}
          </form>
        </Panel>
        <Panel title="Campaigns">
          {campaigns.length === 0 && <div className="muted">No campaigns yet.</div>}
          {campaigns.map((c) => (
            <div key={c.id} style={{ padding: "8px 0", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
              <div className="row between"><b>{c.name}</b><Badge kind={c.status} /></div>
              <div className="faint">{c.deviceKind} → {c.targetVersion} · {c.siteId ?? "all sites"} · stage {c.stage}</div>
              <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${c.progress}%` }} /></div>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}
