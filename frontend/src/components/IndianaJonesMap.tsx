import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import type { AircraftDossier, FlightPosition, PollingStatus } from "../types/flight";
import {
  fetchAircraftDossier,
  fetchHistory,
  fetchLivePositions,
  fetchPollingStatus,
  restartPolling,
  subscribeLiveFeed,
} from "../api/flightApi";
import "./IndianaJonesMap.css";

// How often the header badge re-checks the poll window's remaining time.
// Independent of flighttracker.agents.poll-interval-seconds (that's how
// often the backend hits OpenSky) — this just keeps the countdown display
// fresh.
const STATUS_POLL_MS = 5_000;

// How often to re-fetch the full live set and reconcile local state against
// it. The WebSocket delivers new/updated positions as they land, but never
// tells the client an aircraft should be *removed* — that only happens by
// re-asking the server, whose /live query is what actually knows an
// aircraft has been landed 20+ minutes or gone stale (see FlightController).
// Without this, a marker would never leave the map during a single open
// session no matter how long ago its aircraft landed.
const LIVE_RECONCILE_MS = 60_000;

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

function planeIcon(headingDeg: number | null, selected: boolean) {
  // Every rotation angle coincides with some real heading, so "just don't
  // rotate it" (or default to any other fixed angle) still misrepresents
  // an unknown heading as a specific real reading. Give unknown headings
  // a distinct outline style instead, independent of rotation, so they
  // can't be mistaken for a confident reading at any angle.
  const known = headingDeg != null;
  const rotation = known ? headingDeg : 0;
  const glyphClass = known ? "plane-glyph" : "plane-glyph plane-glyph--unknown-heading";
  // The halo lives on a non-rotated wrapper so it stays a circle regardless
  // of the glyph's own rotation.
  return L.divIcon({
    className: `plane-icon${selected ? " plane-icon--selected" : ""}`,
    html: `<div class="plane-icon-halo"></div><div class="${glyphClass}" style="transform: rotate(${rotation}deg)">${PLANE_SVG}</div>`,
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

const SELECTED_MIN_ZOOM = 10;

function FollowSelected({ selectedId, position }: { selectedId: string | null; position: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (!position) return;
    map.flyTo(position, Math.max(map.getZoom(), SELECTED_MIN_ZOOM), { animate: true, duration: 0.8 });
    // Deliberately keyed on selectedId, not position: this should fire once
    // when a *different* aircraft is selected, not on every position tick
    // of the one already selected — otherwise the view would keep
    // re-centering under the user while they're trying to look around.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  return null;
}

export default function IndianaJonesMap() {
  const [positions, setPositions] = useState<Record<string, FlightPosition>>({});
  const [selected, setSelected] = useState<string | null>(null);
  // Captured at click time and kept live-updated by the WebSocket feed and
  // the periodic reconcile below, but — unlike a plain positions[selected]
  // lookup — never nulled out just because the aircraft momentarily isn't
  // in the live set. A user looking at one aircraft's dossier is exactly
  // the wrong moment for it to vanish from under them (e.g. right as it
  // crosses into "landed" and briefly races the next reconcile).
  const [selectedPos, setSelectedPos] = useState<FlightPosition | null>(null);
  const [route, setRoute] = useState<[number, number][]>([]);
  const [dossier, setDossier] = useState<AircraftDossier | null>(null);
  const [polling, setPolling] = useState<PollingStatus | null>(null);
  const [restarting, setRestarting] = useState(false);

  // The live feed subscription below is set up once and outlives every
  // selection change, so its closure can't see updates to `selected` —
  // a ref is how it reads the current value without resubscribing (and
  // re-opening the WebSocket) on every click.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const reconcile = () =>
      fetchLivePositions().then((list) => {
        const byId: Record<string, FlightPosition> = {};
        list.forEach((p) => (byId[p.icao24] = p));
        setPositions(byId);
        if (selectedRef.current && byId[selectedRef.current]) {
          setSelectedPos(byId[selectedRef.current]);
        }
      });
    reconcile();
    const reconcileInterval = setInterval(reconcile, LIVE_RECONCILE_MS);

    const unsubscribe = subscribeLiveFeed((p) => {
      setPositions((prev) => ({ ...prev, [p.icao24]: p }));
      if (p.icao24 === selectedRef.current) {
        setSelectedPos(p);
        setRoute((prev) => {
          const last = prev[prev.length - 1];
          if (last && last[0] === p.latitude && last[1] === p.longitude) return prev;
          return [...prev, [p.latitude, p.longitude]];
        });
      }
    });
    return () => {
      clearInterval(reconcileInterval);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const check = () => fetchPollingStatus().then(setPolling).catch(() => {});
    check();
    const interval = setInterval(check, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  function handleRestartPolling() {
    setRestarting(true);
    restartPolling()
      .then(setPolling)
      .finally(() => setRestarting(false));
  }

  useEffect(() => {
    if (!selected) {
      setRoute([]);
      setDossier(null);
      setSelectedPos(null);
      return;
    }
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // last 6h of history
    fetchHistory(selected, from, to).then((track) => {
      setRoute(track.map((p) => [p.latitude, p.longitude]));
    });
    setDossier(null); // clear the previous aircraft's fields while the new lookup is in flight
    // Best-effort: a failed lookup just leaves the dossier fields at their
    // "—" fallback rather than surfacing an error — this is enrichment,
    // not core data, and shouldn't block the zoom/panel from working.
    fetchAircraftDossier(selected).then(setDossier).catch(() => setDossier(null));
  }, [selected]);

  const list = Object.values(positions);

  return (
    <div className="expedition-frame">
      <header className="dossier-header">
        <span className="dossier-eyebrow">Aeronautical Survey &amp; Charting Office</span>
        <h1>Live Traffic Chart</h1>
        <div className="polling-status">
          {polling?.active ? (
            <span className="polling-badge polling-badge--live">Watch active · {polling.secondsRemaining}s</span>
          ) : (
            <>
              <span className="polling-badge polling-badge--stopped">Watch stood down</span>
              <button className="polling-restart" onClick={handleRestartPolling} disabled={restarting}>
                {restarting ? "Resuming…" : "Resume Watch"}
              </button>
            </>
          )}
        </div>
      </header>

      <MapContainer center={[59.33, 18.06]} zoom={6} className="expedition-map" zoomControl={false}>
        <TileLayer
          className="parchment-tiles"
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitOnFirstLoad positions={list} />
        <FollowSelected
          selectedId={selected}
          position={selectedPos ? [selectedPos.latitude, selectedPos.longitude] : null}
        />

        {route.length > 1 && <Polyline positions={route} className="route-line" pathOptions={{ color: "#9c3b2e", weight: 2, dashArray: "6 8" }} />}

        {list.map((p) => (
          <Marker
            key={p.icao24}
            position={[p.latitude, p.longitude]}
            icon={planeIcon(p.headingDeg, p.icao24 === selected)}
            eventHandlers={{
              click: () => {
                setSelected(p.icao24);
                setSelectedPos(p);
              },
            }}
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
            <dl className="expedition-log-details">
              <dt>Type</dt><dd>{dossier?.model || "—"}</dd>
              <dt>Registration</dt><dd>{dossier?.registration || "—"}</dd>
              <dt>Operator</dt><dd>{dossier?.operator || "—"}</dd>
              <dt>Origin</dt><dd>{dossier?.originAirportName || dossier?.originAirport || "—"}</dd>
              <dt>Destination</dt><dd>{dossier?.destinationAirportName || dossier?.destinationAirport || "—"}</dd>
            </dl>
            <button className="expedition-close" onClick={() => setSelected(null)}>Close Dossier</button>
          </div>
        </aside>
      )}
    </div>
  );
}
