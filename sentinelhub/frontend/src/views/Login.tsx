import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useStore } from "../state/store";

const DEMO = [
  ["admin", "Super-Admin"], ["agencyadmin", "Agency Admin"], ["siteadmin", "Site Admin (Port)"], ["supervisor", "Supervisor"],
  ["operator", "Operator"], ["investigator", "Investigator"], ["exec", "Executive"], ["auditor", "Auditor"],
];

export function Login() {
  const { login, loginError, loading } = useStore();
  const [u, setU] = useState("operator");
  const [p, setP] = useState("Sentinel!2026");
  const [mfa, setMfa] = useState("");

  const submit = (e: FormEvent) => { e.preventDefault(); void login(u, p, mfa || undefined); };

  return (
    <div className="login">
      <form className="glass card" onSubmit={submit}>
        <div className="brand"><Shield /> <div>SentinelHub<br /><small>Unified Command Platform</small></div></div>
        <h1>Sign in</h1>
        <label>Username<input value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" required /></label>
        <label>Password<input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required /></label>
        <label>MFA code <span className="faint">(optional — unlocks export, unmask, firmware, cert actions)</span>
          <input value={mfa} onChange={(e) => setMfa(e.target.value)} inputMode="numeric" placeholder="246810 in demo" />
        </label>
        {loginError && <div className="err" role="alert">{loginError}</div>}
        <button className="btn primary" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
        <div>
          <div className="faint" style={{ marginBottom: 6 }}>Demo accounts (password <span className="mono">Sentinel!2026</span>)</div>
          <div className="chips">{DEMO.map(([id, label]) => <button type="button" key={id} className="chip" onClick={() => setU(id)}>{label}</button>)}</div>
        </div>
        <div className="faint">{api.mode === "mock" ? "Running on the in-browser simulator (no backend)." : "Connected to the SentinelHub API."}</div>
      </form>
    </div>
  );
}

export function Shield() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden width="28" height="28"><path d="M16 4 6 8v8c0 5.500 4 9.500 10 11 6-1.500 10-5.500 10-11V8z" fill="none" stroke="#22d3ee" strokeWidth="2" /><circle cx="16" cy="15" r="3" fill="#22d3ee" /></svg>
  );
}
