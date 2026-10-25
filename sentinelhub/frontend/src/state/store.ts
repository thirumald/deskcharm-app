import { create } from "zustand";
import { api, ApiError, type Device, type EventItem, type Me, type Session, type Site, type Track } from "../api";

export type View = "overview" | "wall" | "map" | "devices" | "access";
export type Link = "offline" | "connecting" | "live" | "reconnecting" | "closed";

const HISTORY = 60;
let stopLive: (() => void) | null = null;

interface Store {
  session: Session | null;
  me: Me | null;
  sites: Site[];
  devices: Device[];
  events: EventItem[];
  tracks: Record<string, Track[]>;
  series: Record<string, number[]>;
  link: Link;
  flash: EventItem | null;
  loginError: string | null;
  loading: boolean;

  login(u: string, p: string, mfa?: string): Promise<void>;
  logout(): void;
  load(): Promise<void>;
  ack(id: string): Promise<string | null>;
  dismissFlash(): void;
}

export const useStore = create<Store>((set, get) => ({
  session: null, me: null, sites: [], devices: [], events: [], tracks: {}, series: {}, link: "offline",
  flash: null, loginError: null, loading: false,

  async login(u, p, mfa) {
    set({ loginError: null, loading: true });
    try {
      const session = await api.login(u, p, mfa);
      set({ session });
      await get().load();
    } catch (e) {
      set({ loginError: e instanceof ApiError || e instanceof Error ? e.message : "Sign-in failed", loading: false });
    }
  },

  logout() {
    stopLive?.(); stopLive = null;
    api.logout();
    set({ session: null, me: null, sites: [], devices: [], events: [], tracks: {}, series: {}, link: "offline", flash: null, loading: false });
  },

  async load() {
    set({ loading: true });
    try {
      const [me, sites, devices, events] = await Promise.all([api.me(), api.sites(), api.devices(), api.events()]);
      set({ me, sites, devices, events, loading: false, session: get().session ?? { token: "", expiresAt: "", mfa: me.mfa, user: me } });
      stopLive?.();
      stopLive = api.connectLive({
        onState: (link) => set({ link }),
        onTracks: (siteId, tracks) => set((s) => ({ tracks: { ...s.tracks, [siteId]: tracks } })),
        onEvent: (e) => set((s) => ({
          events: [e, ...s.events.filter((x) => x.id !== e.id)].slice(0, 200),
          flash: e.severity === "critical" ? e : s.flash,
        })),
        onTelemetry: (_site, readings) => set((s) => {
          const series = { ...s.series };
          for (const r of readings) {
            const k = `${r.deviceId}|${r.metric}`;
            series[k] = [...(series[k] ?? []), r.value].slice(-HISTORY);
          }
          return { series };
        }),
        onDeviceStatus: (id, status) => set((s) => ({ devices: s.devices.map((d) => (d.id === id ? { ...d, status } : d)) })),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) get().logout();
      set({ loading: false, loginError: e instanceof Error ? e.message : "Failed to load" });
    }
  },

  async ack(id) {
    try {
      await api.ackEvent(id);
      const me = get().me?.username ?? "me";
      set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, state: "ack", ackBy: me, ackAt: new Date().toISOString() } : e)) }));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Failed";
    }
  },

  dismissFlash: () => set({ flash: null }),
}));

export const can = (me: Me | null, permission: string) => !!me?.permissions.includes(permission);
