import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import type { FlightPosition } from "../types/flight";
import { fetchHistory, fetchLivePositions, subscribeLiveFeed } from "../api/flightApi";
import "./IndianaJonesMap.css";

// A small rotated biplane glyph stands in for the transponder icon —
// heading comes straight off the state vector. The ✈ glyph itself renders
// nose-up-and-to-the-left (pointing roughly NW, i.e. -45°) in the fonts
// this actually gets rendered in, not north, so a bare rotate(headingDeg)
// leaves every plane pointing 45° off its true heading. Correct for the
// glyph's native orientation before applying the compass heading.
const PLANE_GLYPH_OFFSET_DEG = 45;

function planeIcon(headingDeg: number | null) {
  // Unknown heading gets no rotation at all (the glyph's raw native
  // orientation) rather than defaulting to 0° and then applying the
  // offset — otherwise "we don't know the heading" would render
  // indistinguishably from "heading is roughly NE", which is worse than
  // the pre-fix behavior it would otherwise silently replace.
  const rotation = headingDeg === null ? 0 : headingDeg + PLANE_GLYPH_OFFSET_DEG;
  return L.divIcon({
    className: "plane-icon",
    html: `<div class="plane-glyph" style="transform: rotate(${rotation}deg)">&#9992;</div>`,
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
