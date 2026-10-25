import type { ReactNode } from "react";
import type { Severity } from "../api";

export function Badge({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={`badge b-${kind}`}>{children ?? kind.replace("_", " ")}</span>;
}

export const SeverityBadge = ({ s }: { s: Severity }) => <Badge kind={s} />;

export function Kpi({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string }) {
  return (
    <div className="glass kpi" style={accent ? ({ "--accent": accent } as React.CSSProperties) : undefined}>
      <div className="label">{label}</div>
      <div className="value num">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, className = "" }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass panel ${className}`}>
      <h3><span>{title}</span>{actions}</h3>
      {children}
    </section>
  );
}

export function Spark({ data, color = "var(--cyan)" }: { data: number[]; color?: string }) {
  if (data.length < 2) return <svg className="spark" aria-hidden />;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${30 - ((v - min) / span) * 26 - 2}`).join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <polyline points={`0,30 ${pts} 100,30`} fill={color} opacity="0.12" stroke="none" />
    </svg>
  );
}

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : "—");
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");
export const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
