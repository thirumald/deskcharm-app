import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Device } from "../api";

// One shared ~15 fps loop drives every tile; far cheaper than a rAF per canvas.
const drawers = new Set<(t: number) => void>();
let timer: number | undefined;
function subscribe(fn: (t: number) => void) {
  drawers.add(fn);
  if (timer === undefined) timer = window.setInterval(() => { const t = performance.now(); drawers.forEach((d) => d(t)); }, 66);
  return () => { drawers.delete(fn); if (!drawers.size && timer !== undefined) { clearInterval(timer); timer = undefined; } };
}

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

interface Actor { x: number; y: number; vx: number; vy: number; w: number; h: number; label: string }

function makeActors(seed: number): Actor[] {
  let a = seed;
  const r = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  return Array.from({ length: 2 + Math.floor(r() * 3) }, () => {
    const vehicle = r() > 0.55;
    return { x: r(), y: 0.45 + r() * 0.4, vx: (r() - 0.5) * (vehicle ? 0.05 : 0.02), vy: 0, w: vehicle ? 0.16 : 0.05, h: vehicle ? 0.1 : 0.15, label: vehicle ? "vehicle" : "person" };
  });
}

type Access = "pending" | "ok" | "denied" | "error";

/**
 * Simulated camera feed. Real deployments swap the canvas for a WebRTC / WebCodecs <video> bound to the
 * stream token issued by POST /api/streams/{id}/token — RBAC is enforced when that token is issued.
 */
export function VideoTile({ device, tier = "T2", focus, onClick }: { device: Device; tier?: string; focus?: boolean; onClick?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [access, setAccess] = useState<Access>("pending");
  const [reason, setReason] = useState("");
  const offline = device.status !== "active";

  useEffect(() => {
    let cancelled = false;
    setAccess("pending");
    api.streamToken(device.id, tier).then(
      () => !cancelled && setAccess("ok"),
      (e) => { if (cancelled) return; setReason(e instanceof Error ? e.message : ""); setAccess(e instanceof ApiError && e.status === 403 ? "denied" : "error"); },
    );
    return () => { cancelled = true; };
  }, [device.id, tier]);

  useEffect(() => {
    const c = ref.current;
    if (!c || access !== "ok" || offline) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const seed = hash(device.id);
    const actors = makeActors(seed);
    const hue = 180 + (seed % 60);
    return subscribe((t) => {
      const W = c.width, H = c.height;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `hsl(${hue} 25% 9%)`); g.addColorStop(0.5, `hsl(${hue} 18% 14%)`); g.addColorStop(1, `hsl(${hue} 12% 7%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // perspective floor grid
      ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = -6; i <= 6; i++) { ctx.moveTo(W / 2 + i * 8, H * 0.4); ctx.lineTo(W / 2 + i * 70, H); }
      for (let j = 0; j < 6; j++) { const y = H * (0.4 + 0.6 * (j / 6) ** 1.6); ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
      // actors + detection boxes
      ctx.font = "9px ui-monospace, monospace";
      for (const a of actors) {
        a.x += a.vx * 0.066; if (a.x < -0.1) a.x = 1.1; if (a.x > 1.1) a.x = -0.1;
        const x = a.x * W, y = a.y * H, w = a.w * W, h = a.h * H;
        ctx.fillStyle = a.label === "vehicle" ? "rgba(148,163,184,0.45)" : "rgba(203,213,225,0.5)";
        ctx.fillRect(x - w / 2, y - h, w, h);
        ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 1; ctx.strokeRect(x - w / 2 - 2, y - h - 2, w + 4, h + 4);
        ctx.fillStyle = "#22d3ee"; ctx.fillText(a.label, x - w / 2, y - h - 5);
      }
      // sensor noise + scanline
      ctx.fillStyle = "rgba(255,255,255,0.025)";
      for (let i = 0; i < 40; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
      ctx.fillStyle = "rgba(34,211,238,0.05)"; ctx.fillRect(0, ((t / 20) % (H + 20)) - 10, W, 3);
    });
  }, [access, offline, device.id]);

  return (
    <div className={`tile${focus ? " focus" : ""}`} onClick={onClick} role="button" tabIndex={0} aria-label={`Camera ${device.name}`}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick?.()}>
      <canvas ref={ref} width={320} height={180} />
      <div className="hud top"><span>{device.name}</span><span className={access === "ok" && !offline ? "rec" : ""}>{tier}</span></div>
      <div className="hud bot"><span>{String(device.attrs.codec ?? "H.265")} · {String(device.attrs.resolution ?? "4MP")}</span><span>{device.siteId}</span></div>
      {offline && <div className="overlay">NO SIGNAL<br /><span className="faint">RTSP keepalive lost</span></div>}
      {!offline && access === "pending" && <div className="overlay">Requesting stream token…</div>}
      {!offline && access === "denied" && <div className="overlay denied">ACCESS DENIED<br /><span className="faint">{reason}</span></div>}
      {!offline && access === "error" && <div className="overlay denied">STREAM ERROR<br /><span className="faint">{reason}</span></div>}
    </div>
  );
}
