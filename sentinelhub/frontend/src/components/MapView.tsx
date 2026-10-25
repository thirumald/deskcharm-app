import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection } from "geojson";
import { api, type CameraHit, type Device } from "../api";
import { useStore } from "../state/store";
import { Badge, Panel } from "./ui";
import { VideoTile } from "./VideoTile";

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    base: {
      type: "raster", tileSize: 256, attribution: "© OpenStreetMap contributors © CARTO",
      tiles: ["a", "b", "c"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`),
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0b0f17" } },
    { id: "base", type: "raster", source: "base", paint: { "raster-opacity": 0.9 } },
  ],
};

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const LAYERS = [
  { id: "fov", label: "Camera FOV (PostGIS)", ids: ["fov-fill", "fov-line"] },
  { id: "fence", label: "Geofences", ids: ["fence-fill", "fence-line"] },
  { id: "dev", label: "Cameras / radars / sensors", ids: ["dev"] },
  { id: "trk", label: "Radar tracks + trails", ids: ["trk", "trail"] },
  { id: "alm", label: "Active alarms", ids: ["alm"] },
] as const;

export function MapView() {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const trails = useRef(new Map<string, [number, number][]>());
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState<Record<string, boolean>>({ fov: true, fence: true, dev: true, trk: true, alm: true });
  const [selected, setSelected] = useState<Device | null>(null);
  const [pick, setPick] = useState<{ lon: number; lat: number; hits: CameraHit[] } | null>(null);
  const { devices, sites, tracks, events } = useStore();
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  // ---- create map once
  useEffect(() => {
    if (!host.current) return;
    const map = new maplibregl.Map({ container: host.current, style: STYLE, center: [72.9, 19.05], zoom: 10.2, attributionControl: { compact: true } });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("load", async () => {
      for (const id of ["fov", "fence", "dev", "trk", "trail", "alm"]) map.addSource(id, { type: "geojson", data: EMPTY });
      map.addLayer({ id: "fov-fill", type: "fill", source: "fov", paint: { "fill-color": ["case", ["==", ["get", "status"], "active"], "#22d3ee", "#64748b"], "fill-opacity": 0.14 } });
      map.addLayer({ id: "fov-line", type: "line", source: "fov", paint: { "line-color": "#22d3ee", "line-opacity": 0.35, "line-width": 0.6 } });
      map.addLayer({ id: "fence-fill", type: "fill", source: "fence", paint: { "fill-color": "#ef4444", "fill-opacity": 0.14 } });
      map.addLayer({ id: "fence-line", type: "line", source: "fence", paint: { "line-color": "#ef4444", "line-width": 1.5, "line-dasharray": [2, 2] } });
      map.addLayer({ id: "trail", type: "line", source: "trail", paint: { "line-color": "#f8fafc", "line-opacity": 0.4, "line-width": 1.2 } });
      map.addLayer({
        id: "dev", type: "circle", source: "dev",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 15, ["match", ["get", "kind"], "radar", 9, "camera", 6, 4]],
          "circle-color": ["match", ["get", "kind"], "radar", "#8b5cf6", "sensor", "#f59e0b", ["case", ["==", ["get", "status"], "active"], "#10b981", "#ef4444"]],
          "circle-stroke-color": "#0b0f17", "circle-stroke-width": 1.2,
        },
      });
      map.addLayer({
        id: "trk", type: "circle", source: "trk",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 16, 7],
          "circle-color": ["match", ["get", "class"], "person", "#fde047", "vehicle", "#38bdf8", "drone", "#f472b6", "#e2e8f0"],
          "circle-stroke-color": "#000", "circle-stroke-width": 1,
        },
      });
      map.addLayer({ id: "alm", type: "circle", source: "alm", paint: { "circle-radius": 14, "circle-color": "rgba(239,68,68,0.15)", "circle-stroke-color": "#ef4444", "circle-stroke-width": 2 } });

      map.on("click", "dev", (e) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        const d = devicesRef.current.find((x) => x.id === id);
        if (d) { setSelected(d); setPick(null); }
      });
      map.on("click", async (e) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: ["dev"] });
        if (hit.length) return;
        setSelected(null);
        const hits = await api.nearestCameras(e.lngLat.lng, e.lngLat.lat, 5).catch(() => []);
        setPick({ lon: e.lngLat.lng, lat: e.lngLat.lat, hits });
      });
      for (const l of ["dev"]) {
        map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
      }
      const [fov, fences] = await Promise.all([api.fov(), api.geofences()]).catch(() => [EMPTY, EMPTY]);
      (map.getSource("fov") as GeoJSONSource).setData(fov);
      (map.getSource("fence") as GeoJSONSource).setData(fences);
      setReady(true);
    });
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ---- data -> sources
  const deviceFc = useMemo<FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: devices.filter((d) => d.kind !== "iot_gateway").map((d): Feature => ({
      type: "Feature", geometry: { type: "Point", coordinates: [d.lon, d.lat] },
      properties: { id: d.id, name: d.name, kind: d.kind, status: d.status },
    })),
  }), [devices]);

  useEffect(() => { if (ready) (mapRef.current!.getSource("dev") as GeoJSONSource).setData(deviceFc); }, [ready, deviceFc]);

  useEffect(() => {
    if (!ready) return;
    const all = Object.values(tracks).flat();
    for (const t of all) {
      const tr = trails.current.get(t.trackId) ?? [];
      tr.push([t.lon, t.lat]);
      if (tr.length > 25) tr.shift();
      trails.current.set(t.trackId, tr);
    }
    const map = mapRef.current!;
    (map.getSource("trk") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: all.map((t): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [t.lon, t.lat] }, properties: { trackId: t.trackId, class: t.class } })),
    });
    (map.getSource("trail") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: [...trails.current.values()].filter((l) => l.length > 1).map((l): Feature => ({ type: "Feature", geometry: { type: "LineString", coordinates: l }, properties: {} })),
    });
  }, [ready, tracks]);

  useEffect(() => {
    if (!ready) return;
    const active = events.filter((e) => e.state === "new" && (e.severity === "critical" || e.severity === "major") && e.lon != null && e.lat != null).slice(0, 20);
    (mapRef.current!.getSource("alm") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: active.map((e): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [e.lon!, e.lat!] }, properties: { id: e.id } })),
    });
  }, [ready, events]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current!;
    for (const l of LAYERS) for (const id of l.ids) map.setLayoutProperty(id, "visibility", visible[l.id] ? "visible" : "none");
  }, [ready, visible]);

  const fly = (lon: number, lat: number, zoom = 15.3) => mapRef.current?.flyTo({ center: [lon, lat], zoom, duration: 1200 });

  return (
    <div className="mapwrap">
      <div ref={host} />
      <div className="glass map-layers">
        <div className="panel-title">Layers</div>
        {LAYERS.map((l) => (
          <label key={l.id} className="check">
            <input type="checkbox" checked={visible[l.id]} onChange={(e) => setVisible((v) => ({ ...v, [l.id]: e.target.checked }))} /> {l.label}
          </label>
        ))}
        <div className="panel-title" style={{ marginTop: 8 }}>Fly to</div>
        {sites.map((s) => <button key={s.id} className="btn sm ghost" onClick={() => fly(s.lon, s.lat, s.kind === "main" ? 12 : 15.3)}>{s.name}</button>)}
      </div>

      {(selected || pick) && (
        <div className="map-detail glass">
          {selected && (
            <Panel title={selected.name} actions={<button className="btn sm ghost" onClick={() => setSelected(null)}>✕</button>} className="">
              <div className="row wrap"><Badge kind={selected.status} /><span className="muted">{selected.kind}</span><span className="faint mono">{selected.ip ?? ""}</span></div>
              <p className="faint mono" style={{ wordBreak: "break-all" }}>{selected.nodePath}</p>
              {selected.kind === "camera" && <VideoTile device={selected} tier="T1" />}
              <div className="muted" style={{ marginTop: 8 }}>{selected.vendor} {selected.model} · fw {selected.firmware}</div>
            </Panel>
          )}
          {pick && (
            <Panel title="Nearest cameras (KNN)" actions={<button className="btn sm ghost" onClick={() => setPick(null)}>✕</button>}>
              <div className="faint mono">{pick.lat.toFixed(5)}, {pick.lon.toFixed(5)}</div>
              {pick.hits.length === 0 && <div className="muted">No cameras visible to you here.</div>}
              {pick.hits.map((h) => (
                <button key={h.id} className="btn sm ghost row between" style={{ width: "100%", marginTop: 4 }}
                  onClick={() => { const d = devices.find((x) => x.id === h.id); if (d) { setSelected(d); setPick(null); fly(d.lon, d.lat, 16.5); } }}>
                  <span>{h.name}</span><span className="faint mono">{Math.round(h.meters)} m</span>
                </button>
              ))}
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
