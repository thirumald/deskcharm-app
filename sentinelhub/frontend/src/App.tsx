import { useEffect, useState } from "react";
import { api } from "./api";
import { Badge } from "./components/ui";
import { can, useStore, type View } from "./state/store";
import { Access } from "./views/Access";
import { Devices } from "./views/Devices";
import { LiveWall } from "./views/LiveWall";
import { Login, Shield } from "./views/Login";
import { MapPage } from "./views/MapPage";
import { Overview } from "./views/Overview";

const NAV: { id: View; label: string; need?: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "wall", label: "Live Wall", need: "video.live" },
  { id: "map", label: "Map", need: "geo.view" },
  { id: "devices", label: "Devices", need: "geo.view" },
  { id: "access", label: "Access & Audit" },
];

const fromHash = (): View => (NAV.find((n) => n.id === location.hash.slice(1))?.id ?? "overview");

export default function App() {
  const { session, me, link, flash, dismissFlash, logout, ack } = useStore();
  const [view, setView] = useState<View>(fromHash());
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const h = () => setView(fromHash());
    addEventListener("hashchange", h);
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => { removeEventListener("hashchange", h); clearInterval(t); };
  }, []);

  // Resume a stored session (live mode keeps its token in sessionStorage).
  useEffect(() => {
    if (api.mode === "live" && "hasToken" in api && (api as { hasToken(): boolean }).hasToken()) void useStore.getState().load();
  }, []);

  if (!session || !me) return <Login />;

  const nav = NAV.filter((n) => !n.need || can(me, n.need));
  const current = nav.find((n) => n.id === view)?.id ?? "overview";
  const initials = me.displayName.split(" ").map((w) => w[0]).slice(0, 2).join("");

  return (
    <div className="shell">
      <header className="glass topbar">
        <div className="brand"><Shield /><div>SentinelHub <small>Command</small></div></div>
        <nav className="nav" aria-label="Primary">
          {nav.map((n) => <button key={n.id} aria-current={current === n.id ? "page" : undefined} onClick={() => { location.hash = n.id; }}>{n.label}</button>)}
        </nav>
        <div className="spacer" />
        <Badge kind={api.mode === "mock" ? "info" : "active"}>{api.mode === "mock" ? "Simulated" : "Live API"}</Badge>
        <Badge kind={link === "live" ? "live" : link === "offline" ? "closed" : link}>{link === "live" ? "Feed live" : `Feed ${link}`}</Badge>
        <span className="num muted">{now.toLocaleTimeString([], { hour12: false })}</span>
        <div className="userchip">
          <div className="avatar" aria-hidden>{initials}</div>
          <div><div>{me.displayName}</div><div className="faint" style={{ fontSize: 11 }}>{me.agency}{me.mfa ? " · MFA" : ""}</div></div>
          <button className="btn sm" onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="content">
        {current === "overview" && <Overview />}
        {current === "wall" && <LiveWall />}
        {current === "map" && <MapPage />}
        {current === "devices" && <Devices />}
        {current === "access" && <Access />}
      </main>

      {flash && (
        <div className="glass toast" role="alert">
          <div><Badge kind="critical" /> <b>{flash.message}</b><div className="faint">{flash.siteId} · {flash.kind}</div></div>
          {can(me, "alarm.handle") && <button className="btn sm" onClick={() => { void ack(flash.id); dismissFlash(); }}>Ack</button>}
          <button className="btn sm ghost" onClick={dismissFlash} aria-label="Dismiss">✕</button>
        </div>
      )}
    </div>
  );
}
