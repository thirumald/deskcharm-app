import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Panel, SeverityBadge, ago } from "../components/ui";
import { VideoTile } from "../components/VideoTile";
import { can, useStore } from "../state/store";

const LAYOUTS = [{ id: 2, label: "2×2" }, { id: 3, label: "3×3" }, { id: 4, label: "4×4" }];

export function LiveWall() {
  const { sites, devices, events, me, ack } = useStore();
  const [site, setSite] = useState("all");
  const [cols, setCols] = useState(3);
  const [page, setPage] = useState(0);
  const [follow, setFollow] = useState(true);
  const [pinned, setPinned] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const seen = useRef(new Set<string>());

  const cams = useMemo(
    () => devices.filter((d) => d.kind === "camera" && (site === "all" || d.siteId === site)).sort((a, b) => Number(b.status === "active") - Number(a.status === "active")),
    [devices, site],
  );
  const perPage = cols * cols;
  const pages = Math.max(1, Math.ceil(cams.length / perPage));
  const shown = cams.slice(page * perPage, page * perPage + perPage);

  // Auto-follow: a new alarm with a camera pins that camera to tile 0 until dismissed.
  useEffect(() => {
    const fresh = events.find((e) => e.deviceId && e.state === "new" && !seen.current.has(e.id));
    for (const e of events) seen.current.add(e.id);
    if (follow && fresh && (fresh.severity === "critical" || fresh.severity === "major") && devices.some((d) => d.id === fresh.deviceId && d.kind === "camera"))
      setPinned(fresh.deviceId!);
  }, [events, follow, devices]);

  const pinnedDev = pinned ? devices.find((d) => d.id === pinned) : undefined;
  const tiles = pinnedDev ? [pinnedDev, ...shown.filter((d) => d.id !== pinned)].slice(0, perPage) : shown;
  const canWall = can(me, "wall.control");

  return (
    <div className="wall">
      <div className="grid" style={{ gridTemplateRows: "auto 1fr", minHeight: 0 }}>
        <div className="glass panel row wrap between" style={{ padding: "8px 12px" }}>
          <div className="row wrap">
            <select value={site} onChange={(e) => { setSite(e.target.value); setPage(0); }} aria-label="Site filter">
              <option value="all">All sites</option>
              {sites.filter((s) => s.kind === "edge").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {LAYOUTS.map((l) => <button key={l.id} className={`btn sm${cols === l.id ? " primary" : ""}`} disabled={!canWall} onClick={() => { setCols(l.id); setPage(0); }}>{l.label}</button>)}
            <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow alarms</label>
            {pinnedDev && <button className="btn sm" onClick={() => setPinned(null)}>Unpin {pinnedDev.name}</button>}
          </div>
          <div className="row">
            <button className="btn sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
            <span className="num muted">{page + 1} / {pages}</span>
            <button className="btn sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>›</button>
          </div>
        </div>
        <div className="scroll">
          <div className="tiles" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {tiles.map((d) => <VideoTile key={d.id} device={d} tier={cols >= 3 ? "T2" : "T1"} focus={d.id === pinned} onClick={() => setPinned(d.id === pinned ? null : d.id)} />)}
          </div>
          {cams.length === 0 && <div className="glass panel muted">No cameras are visible to your role.</div>}
        </div>
      </div>

      <Panel title="Alarm queue" className="scroll">
        {msg && <div className="err" role="alert">{msg}</div>}
        {events.slice(0, 40).map((e) => (
          <div key={e.id} className={`alarm ${e.severity} ${e.state}`} onClick={() => e.deviceId && setPinned(e.deviceId)} style={{ cursor: e.deviceId ? "pointer" : "default" }}>
            <span className="rail" />
            <div><div className="msg">{e.message}</div><div className="meta"><SeverityBadge s={e.severity} /> {e.siteId} · {ago(e.ts)}</div></div>
            {e.state === "new" ? (
              <button className="btn sm" onClick={async (ev) => { ev.stopPropagation(); setMsg((await ack(e.id)) ?? ""); }}>Ack</button>
            ) : <Badge kind="ack" />}
          </div>
        ))}
      </Panel>
    </div>
  );
}
