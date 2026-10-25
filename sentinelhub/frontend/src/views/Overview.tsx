import { useEffect, useMemo, useState } from "react";
import { api, SEVERITY_ORDER, type HealthSummary } from "../api";
import { Badge, Kpi, Panel, Spark, SeverityBadge, ago } from "../components/ui";
import { can, useStore } from "../state/store";

const METRIC_LABEL: Record<string, [string, string]> = {
  temperature_c: ["Temperature", "°C"], vibration_mm_s: ["Vibration", "mm/s"], power_kw: ["Power", "kW"],
  humidity_pct: ["Humidity", "%"], door_open: ["Door open", ""], smoke_ppm: ["Smoke", "ppm"],
};

const TIERS = [
  { id: "T0", name: "Native (Edge LAN only)", kbps: null as number | null, note: "H.265 recorded at the Edge, never crosses the WAN" },
  { id: "T1", name: "Mezzanine – on demand", kbps: 1200, note: "AV1/H.265 1080p@15 · operator drill-in" },
  { id: "T2", name: "Proxy – wall tiles", kbps: 450, note: "720p@8 · tagged cameras only" },
  { id: "T3", name: "Thumbnail", kbps: 30, note: "320p@1 · map previews" },
];

export function Overview() {
  const { sites, devices, events, series, me, ack } = useStore();
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [siteSel, setSiteSel] = useState("");

  useEffect(() => {
    let live = true;
    const load = () => api.health().then((h) => live && setHealth(h)).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const edges = sites.filter((s) => s.kind === "edge");
  useEffect(() => { if (!siteSel && edges[0]) setSiteSel(edges[0].id); }, [edges, siteSel]);

  const stat = useMemo(() => {
    const out: Record<string, { cams: number; camsUp: number; radars: number; sensors: number; devices: number; up: number }> = {};
    for (const h of health?.devices ?? []) {
      const s = (out[h.siteId] ??= { cams: 0, camsUp: 0, radars: 0, sensors: 0, devices: 0, up: 0 });
      if (h.status === "decommissioned") continue;
      s.devices += h.count;
      if (h.status === "active") s.up += h.count;
      if (h.kind === "camera") { s.cams += h.count; if (h.status === "active") s.camsUp += h.count; }
      if (h.kind === "radar") s.radars += h.count;
      if (h.kind === "sensor") s.sensors += h.count;
    }
    return out;
  }, [health]);

  const totals = Object.values(stat).reduce((a, s) => ({ devices: a.devices + s.devices, up: a.up + s.up, cams: a.cams + s.cams }), { devices: 0, up: 0, cams: 0 });
  const wan = edges.reduce((a, s) => a + s.wanMbps, 0);
  const cams = devices.filter((d) => d.kind === "camera" && d.status !== "decommissioned");
  const nativeMbps = cams.reduce((a, d) => a + Number(d.attrs.bitrateKbps ?? 3000), 0) / 1000;
  const saved = nativeMbps > 0 ? Math.max(0, Math.round((1 - wan / nativeMbps) * 100)) : 0;
  const gbPerDay = (nativeMbps * 1e6 * 86400) / 8 / 1e9;
  const open = events.filter((e) => e.state === "new");
  const bySev = SEVERITY_ORDER.map((s) => ({ s, n: open.filter((e) => e.severity === s).length }));

  const sensors = devices.filter((d) => d.kind === "sensor" && d.siteId === siteSel);

  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="grid kpis">
        <Kpi label="Edge sites online" value={`${edges.filter((s) => s.status === "online").length}/${edges.length}`} sub="federated · autonomous on WAN loss" accent="var(--green)" />
        <Kpi label="Device health" value={totals.devices ? `${Math.round((totals.up / totals.devices) * 100)}%` : "—"} sub={`${totals.up} of ${totals.devices} devices active`} accent="var(--cyan)" />
        <Kpi label="Open alarms" value={open.length} sub={`${bySev[0].n} critical · ${bySev[1].n} major`} accent="var(--red)" />
        <Kpi label="WAN to Main DC" value={<>{wan.toFixed(1)}<small className="muted"> Mbps</small></>} sub={`vs ${nativeMbps.toFixed(0)} Mbps native · ${saved}% saved`} accent="var(--violet)" />
        <Kpi label="Edge hot storage need" value={<>{(gbPerDay * 3 / 1000).toFixed(1)}<small className="muted"> TB</small></>} sub={`72 h @ ${gbPerDay.toFixed(0)} GB/day native`} accent="var(--amber)" />
      </div>

      <div className="grid two">
        <Panel title="Federation — Edge DCs">
          <div className="scroll">
            <table>
              <thead><tr><th>Site</th><th>Link</th><th>Cameras</th><th>Radars</th><th>Sensors</th><th>Health</th><th>WAN</th></tr></thead>
              <tbody>
                {edges.map((s) => {
                  const t = stat[s.id];
                  const pct = t?.devices ? Math.round((t.up / t.devices) * 100) : 0;
                  return (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td><Badge kind={s.status === "online" ? "online" : "offline"} /></td>
                      <td className="num">{t ? `${t.camsUp}/${t.cams}` : "—"}</td>
                      <td className="num">{t?.radars ?? "—"}</td>
                      <td className="num">{t?.sensors ?? "—"}</td>
                      <td style={{ minWidth: 110 }}><div className="row"><div className="bar ok" style={{ flex: 1 }}><i style={{ width: `${pct}%` }} /></div><span className="num faint">{pct}%</span></div></td>
                      <td className="num">{s.wanMbps.toFixed(1)} Mbps</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Active alarms" actions={<div className="row">{bySev.map(({ s, n }) => <span key={s} className="row" style={{ gap: 4 }}><SeverityBadge s={s} /><b className="num">{n}</b></span>)}</div>}>
          <div className="scroll" style={{ maxHeight: 300 }}>
            {events.slice(0, 8).map((e) => (
              <div key={e.id} className={`alarm ${e.severity} ${e.state}`}>
                <span className="rail" />
                <div><div className="msg">{e.message}</div><div className="meta">{e.siteId} · {e.kind} · {ago(e.ts)}{e.ackBy ? ` · ack ${e.ackBy}` : ""}</div></div>
                {e.state === "new" && can(me, "alarm.handle") ? <button className="btn sm" onClick={() => ack(e.id)}>Ack</button> : <Badge kind={e.state} />}
              </div>
            ))}
            {events.length === 0 && <div className="muted">No alarms in your scope.</div>}
          </div>
        </Panel>
      </div>

      <div className="grid two">
        <Panel
          title="Telemetry (TimescaleDB stream)"
          actions={<select value={siteSel} onChange={(e) => setSiteSel(e.target.value)} aria-label="Site">{edges.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        >
          {!can(me, "telemetry.view") ? <div className="muted">Your role cannot view telemetry.</div> : (
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))" }}>
              {sensors.map((d) => {
                const metric = String(d.attrs.metric);
                const data = series[`${d.id}|${metric}`] ?? [];
                const [label, unit] = METRIC_LABEL[metric] ?? [metric, ""];
                const last = data.at(-1);
                return (
                  <div key={d.id} className="glass panel" style={{ padding: 10 }}>
                    <div className="row between"><span className="muted">{label}</span><span className="faint mono">{d.name.split("-").pop()}</span></div>
                    <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{last === undefined ? "—" : last.toFixed(metric === "door_open" ? 0 : 1)} <small className="muted">{unit}</small></div>
                    <Spark data={data} color={metric === "smoke_ppm" ? "var(--amber)" : "var(--cyan)"} />
                  </div>
                );
              })}
              {sensors.length === 0 && <div className="muted">No sensors visible for this site.</div>}
            </div>
          )}
        </Panel>

        <div className="grid">
          <Panel title="Compression tiering (Edge → Main)">
            <table>
              <thead><tr><th>Tier</th><th>Use</th><th style={{ textAlign: "right" }}>Per cam</th></tr></thead>
              <tbody>
                {TIERS.map((t) => (
                  <tr key={t.id}><td><b>{t.id}</b></td><td><div>{t.name}</div><div className="faint" style={{ fontSize: 11 }}>{t.note}</div></td><td className="num" style={{ textAlign: "right" }}>{t.kbps ? `${t.kbps} kbps` : "LAN only"}</td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Storage lifecycle">
            <table>
              <tbody>
                <tr><td><Badge kind="info">Hot</Badge></td><td>Edge NVMe</td><td className="muted">72 h · all streams</td></tr>
                <tr><td><Badge kind="warning">Warm</Badge></td><td>Main DC SAN</td><td className="muted">30–90 d · events + selected</td></tr>
                <tr><td><Badge kind="running">Cold</Badge></td><td>S3 object (WORM)</td><td className="muted">1–7 yrs · evidence</td></tr>
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}
