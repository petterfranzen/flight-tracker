import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import type { FlightPosition } from "../types/flight";
import { fetchHistory, fetchLivePositions, subscribeLiveFeed } from "../api/flightApi";
import "./IndianaJonesMap.css";

// A small rotated dart stands in for the transponder icon — heading comes
// straight off the state vector. This used to be the Unicode ✈ glyph
// (U+2708) rotated by a fixed offset to correct for its assumed native
// orientation, but that orientation isn't a fixed, portable fact — it
// depends on whatever font/platform ends up rendering the emoji fallback
// (the element has no font-family of its own), so the "right" offset on
// one machine was visibly wrong on another. An inline SVG path has no such
// ambiguity: authored pointing straight up (north), so rotate(headingDeg)
// with no correction term is always correct by construction.
const PLANE_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
  <path d="M12 2 L19 20 L12 16 L5 20 Z" />
</svg>`;

function planeIcon(headingDeg: number | null) {
  // Every rotation angle coincides with some real heading, so "just don't
  // rotate it" (or default to any other fixed angle) still misrepresents
  // an unknown heading as a specific real reading. Give unknown headings
  // a distinct outline style instead, independent of rotation, so they
  // can't be mistaken for a confident reading at any angle.
  const known = headingDeg != null;
  const rotation = known ? headingDeg : 0;
  const glyphClass = known ? "plane-glyph" : "plane-glyph plane-glyph--unknown-heading";
  return L.divIcon({
    className: "plane-icon",
    html: `<div class="${glyphClass}" style="transform: rotate(${rotation}deg)">${PLANE_SVG}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function FitOnFirstLoad({ positions }: { positions: FlightPosition[] }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (!fitted.current && positions.length > 0) {
      const bounds = L.latLngBounds(positions.map((p) => [p.latitude, p.longitude]));
      map.fitBounds(bounds.pad(0.2));
      fitted.current = true;
    }
  }, [positions, map]);
  return null;
}

export default function IndianaJonesMap() {
  const [positions, setPositions] = useState<Record<string, FlightPosition>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [route, setRoute] = useState<[number, number][]>([]);

  useEffect(() => {
    fetchLivePositions().then((list) => {
      const byId: Record<string, FlightPosition> = {};
      list.forEach((p) => (byId[p.icao24] = p));
      setPositions(byId);
    });
    const unsubscribe = subscribeLiveFeed((p) => {
      setPositions((prev) => ({ ...prev, [p.icao24]: p }));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!selected) {
      setRoute([]);
      return;
    }
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // last 6h of history
    fetchHistory(selected, from, to).then((track) => {
      setRoute(track.map((p) => [p.latitude, p.longitude]));
    });
  }, [selected]);

  const list = Object.values(positions);
  const selectedPos = selected ? positions[selected] : null;

  return (
    <div className="expedition-frame">
      <header className="dossier-header">
        <span className="dossier-eyebrow">Aeronautical Survey &amp; Charting Office</span>
        <h1>Live Traffic Chart</h1>
      </header>

      <MapContainer center={[59.33, 18.06]} zoom={6} className="expedition-map" zoomControl={false}>
        <TileLayer
          className="parchment-tiles"
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitOnFirstLoad positions={list} />

        {route.length > 1 && <Polyline positions={route} className="route-line" pathOptions={{ color: "#9c3b2e", weight: 2, dashArray: "6 8" }} />}

        {list.map((p) => (
          <Marker
            key={p.icao24}
            position={[p.latitude, p.longitude]}
            icon={planeIcon(p.headingDeg)}
            eventHandlers={{ click: () => setSelected(p.icao24) }}
          >
            <Popup className="dossier-popup">
              <div className="dossier-card">
                <div className="dossier-callsign">{p.callsign?.trim() || p.icao24.toUpperCase()}</div>
                <dl>
                  <dt>Altitude</dt><dd>{p.altitudeM != null ? Math.round(p.altitudeM) + " m" : "—"}</dd>
                  <dt>Speed</dt><dd>{p.velocityMs != null ? Math.round(p.velocityMs * 3.6) + " km/h" : "—"}</dd>
                  <dt>Heading</dt><dd>{p.headingDeg != null ? Math.round(p.headingDeg) + "°" : "—"}</dd>
                  <dt>Source</dt><dd>{p.agentSource}</dd>
                </dl>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {selectedPos && (
        <aside className="expedition-log">
          <div className="expedition-log-inner">
            <span className="dossier-eyebrow">Field Log</span>
            <h2>{selectedPos.callsign?.trim() || selectedPos.icao24.toUpperCase()}</h2>
            <p className="expedition-log-meta">ICAO24 {selectedPos.icao24.toUpperCase()} · last leg traced above</p>
            <button className="expedition-close" onClick={() => setSelected(null)}>Close Dossier</button>
          </div>
        </aside>
      )}
    </div>
  );
}
