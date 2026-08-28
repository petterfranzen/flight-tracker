import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap, useMapEvents } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { AircraftDossier, Bounds, FlightPosition, PollingStatus } from "../types/flight";
import {
  fetchAircraftDossier,
  fetchHistory,
  fetchLivePositions,
  fetchPollingStatus,
  restartPolling,
  stopPolling,
  subscribeLiveFeed,
} from "../api/flightApi";
import "./FlightMap.css";

// How often the header badge re-syncs the poll window's remaining time
// against the server. Independent of flighttracker.agents.poll-interval-seconds
// (that's how often the backend hits OpenSky) — the countdown itself ticks
// locally every second (see the displaySecondsRemaining effect below); this
// interval just corrects any client-side drift and picks up window changes
// from other tabs/devices.
const STATUS_POLL_MS = 5_000;

// How often to re-fetch the current viewport's live set and reconcile
// local state against it. The WebSocket delivers new/updated positions as
// they land, but never tells the client an aircraft should be *removed* —
// that only happens by re-asking the server, whose /live query is what
// actually knows an aircraft has been landed 20+ minutes, gone stale, or
// panned out of view. Without this, a marker would never leave the map
// during a single open session no matter how long ago its aircraft landed
// (or how far the view has moved on).
const LIVE_RECONCILE_MS = 60_000;

const ROUTE_COLOR = "#4db2ff"; // matches --color-accent in FlightMap.css

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
  //
  // role="img"/aria-label here is deliberately static, not per-aircraft —
  // Leaflet's divIcon sets this string as raw innerHTML, so interpolating
  // callsign (external, attacker-influenceable OpenSky data) into it would
  // be an XSS hole. Per-aircraft detail is only ever rendered through real
  // React DOM (the popup, the details panel), which escapes it safely.
  return L.divIcon({
    className: `plane-icon${selected ? " plane-icon--selected" : ""}`,
    html: `<div class="plane-icon-halo" aria-hidden="true"></div><div class="${glyphClass}" style="transform: rotate(${rotation}deg)" role="img" aria-label="Aircraft position marker">${PLANE_SVG}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function boundsFromMap(map: L.Map): Bounds {
  const b = map.getBounds();
  const lonMin = b.getWest();
  const lonMax = b.getEast();
  // At extreme zoom-out (or after panning across wrapped "copies" of the
  // world), Leaflet's bounds can span or exceed a full 360° of longitude
  // (e.g. -1290..1307) — that's not a real bbox, it's "the whole world is
  // visible". Send the actual valid range in that case rather than
  // nonsensical numbers the backend would just clamp against anyway.
  const spansWholeWorld = lonMax - lonMin >= 360;
  return {
    latMin: Math.max(-90, b.getSouth()),
    latMax: Math.min(90, b.getNorth()),
    lonMin: spansWholeWorld ? -180 : lonMin,
    lonMax: spansWholeWorld ? 180 : lonMax,
  };
}

/**
 * Reports the current map viewport up to the parent — once on mount, and
 * again every time panning/zooming settles (moveend only fires once
 * movement has actually stopped, so this is naturally debounced already,
 * not on every intermediate frame of a drag).
 */
function ViewportReporter({ onBoundsChange }: { onBoundsChange: (bounds: Bounds) => void }) {
  const map = useMapEvents({
    moveend: () => onBoundsChange(boundsFromMap(map)),
  });
  useEffect(() => {
    onBoundsChange(boundsFromMap(map));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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

export default function FlightMap() {
  const [positions, setPositions] = useState<Record<string, FlightPosition>>({});
  const [selected, setSelected] = useState<string | null>(null);
  // Captured at click time and kept live-updated by the WebSocket feed and
  // the periodic reconcile below, but — unlike a plain positions[selected]
  // lookup — never nulled out just because the aircraft momentarily isn't
  // in the live set. A user looking at one aircraft's details is exactly
  // the wrong moment for it to vanish from under them (e.g. right as it
  // crosses into "landed" and briefly races the next reconcile).
  const [selectedPos, setSelectedPos] = useState<FlightPosition | null>(null);
  const [route, setRoute] = useState<[number, number][]>([]);
  const [dossier, setDossier] = useState<AircraftDossier | null>(null);
  const [polling, setPolling] = useState<PollingStatus | null>(null);
  // When `polling` was last fetched, so the countdown can tick locally
  // between fetches instead of jumping in STATUS_POLL_MS-sized steps.
  const [pollingSyncedAt, setPollingSyncedAt] = useState(0);
  const [displaySecondsRemaining, setDisplaySecondsRemaining] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  // The live feed subscription below is set up once and outlives every
  // selection change, so its closure can't see updates to `selected` —
  // a ref is how it reads the current value without resubscribing (and
  // re-opening the WebSocket) on every click.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Tracking is global now, but the map only ever wants what's currently
  // visible — this is that viewport, kept in a ref (not state) so the
  // reconcile interval below always reads the latest value from its
  // closure without needing to be torn down and rebuilt on every pan.
  const boundsRef = useRef<Bounds | null>(null);

  function applyLiveSnapshot(bounds: Bounds | null) {
    return fetchLivePositions(bounds ?? undefined).then((list) => {
      const byId: Record<string, FlightPosition> = {};
      list.forEach((p) => (byId[p.icao24] = p));
      setPositions(byId);
      if (selectedRef.current && byId[selectedRef.current]) {
        setSelectedPos(byId[selectedRef.current]);
      }
    });
  }

  function handleBoundsChange(bounds: Bounds) {
    boundsRef.current = bounds;
    applyLiveSnapshot(bounds);
  }

  useEffect(() => {
    // No initial fetch here — ViewportReporter's mount-time report (below,
    // inside MapContainer) supplies the first bounds and triggers the
    // first fetch itself, so there's exactly one initial request instead
    // of a bounds-less one racing a bounds-scoped one.
    const reconcileInterval = setInterval(() => applyLiveSnapshot(boundsRef.current), LIVE_RECONCILE_MS);

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

  function applyPollingStatus(status: PollingStatus) {
    setPolling(status);
    setPollingSyncedAt(Date.now());
  }

  useEffect(() => {
    const check = () => fetchPollingStatus().then(applyPollingStatus).catch(() => {});
    check();
    const interval = setInterval(check, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  // Ticks the displayed countdown down every second, independent of when
  // the last server sync happened, so it counts down smoothly instead of
  // jumping in STATUS_POLL_MS-sized steps.
  useEffect(() => {
    if (!polling?.active) {
      setDisplaySecondsRemaining(0);
      return;
    }
    const tick = () => {
      const elapsedSinceSync = Math.floor((Date.now() - pollingSyncedAt) / 1000);
      setDisplaySecondsRemaining(Math.max(0, polling.secondsRemaining - elapsedSinceSync));
    };
    tick();
    const interval = setInterval(tick, 1_000);
    return () => clearInterval(interval);
  }, [polling, pollingSyncedAt]);

  function handleRestartPolling() {
    setRestarting(true);
    restartPolling()
      .then(applyPollingStatus)
      .finally(() => setRestarting(false));
  }

  function handleStopPolling() {
    setStopping(true);
    stopPolling()
      .then(applyPollingStatus)
      .finally(() => setStopping(false));
  }

  useEffect(() => {
    // Cleared unconditionally, not just on deselect: switching directly
    // from aircraft A to B never passes through "selected = null", so
    // without this the polyline kept showing A's route — and could even
    // grow a stray point onto it — during the gap before B's history fetch
    // below resolves (the live-feed effect appends to `route` the moment a
    // new position for whichever aircraft is now selected arrives, which
    // can easily win that race).
    setRoute([]);
    if (!selected) {
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
    <div className="app-shell">
      <header className="app-header">
        <h1>Flight Tracker</h1>
        <p className="app-header-subtitle">Live aircraft positions</p>
        <div className="polling-status">
          {polling?.active ? (
            <>
              <span className="polling-badge polling-badge--live">Watch active · {displaySecondsRemaining}s</span>
              <button className="polling-restart" onClick={handleStopPolling} disabled={stopping}>
                {stopping ? "Stopping…" : "Stop Watch"}
              </button>
            </>
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

      <MapContainer
        center={[59.33, 18.06]}
        zoom={6}
        minZoom={2}
        // Past this, the world starts wrapping into multiple side-by-side
        // copies — Leaflet's own marker projection gets confused about
        // which copy a marker belongs to at that point (real aircraft ended
        // up rendered far outside the visible map), and getBounds() reports
        // a longitude span that isn't a real bbox at all. minZoom keeps the
        // view to a single, unambiguous world.
        className="map-container"
        zoomControl={false}
        aria-label="Live aircraft map"
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ViewportReporter onBoundsChange={handleBoundsChange} />
        <FollowSelected
          selectedId={selected}
          position={selectedPos ? [selectedPos.latitude, selectedPos.longitude] : null}
        />

        {route.length > 1 && (
          <Polyline positions={route} className="route-line" pathOptions={{ color: ROUTE_COLOR, weight: 3, dashArray: "6 8" }} />
        )}

        {/* Global tracking means the live set can run into the thousands —
            rendering that many individual Leaflet markers directly made
            zooming out to see more than one region unusably laggy (browser
            struggling to keep up with the DOM/reconciliation, badly enough
            that the whole map appeared "stuck" showing whatever had
            already rendered rather than the full current set). Clustering
            keeps the on-screen marker/DOM count bounded regardless of how
            many aircraft are actually loaded; disableClusteringAtZoom
            matches SELECTED_MIN_ZOOM below, so once zoomed in enough for
            individual aircraft to matter, clustering steps out of the way
            entirely. */}
        <MarkerClusterGroup
          chunkedLoading
          maxClusterRadius={70}
          disableClusteringAtZoom={SELECTED_MIN_ZOOM}
          showCoverageOnHover={false}
        >
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
              <Popup className="marker-popup">
                <div className="popup-card">
                  <div className="popup-callsign">{p.callsign?.trim() || p.icao24.toUpperCase()}</div>
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
        </MarkerClusterGroup>
      </MapContainer>

      {selectedPos && (
        <aside className="details-panel" aria-labelledby="details-panel-heading">
          <div className="details-panel-inner">
            <span className="details-panel-eyebrow" id="details-panel-heading">Aircraft Details</span>
            <h2>{selectedPos.callsign?.trim() || selectedPos.icao24.toUpperCase()}</h2>
            <p className="details-panel-meta">ICAO24 {selectedPos.icao24.toUpperCase()} · last leg traced above</p>
            <dl className="details-panel-fields">
              <dt>Type</dt><dd>{dossier?.model || "—"}</dd>
              <dt>Registration</dt><dd>{dossier?.registration || "—"}</dd>
              <dt>Operator</dt><dd>{dossier?.operator || "—"}</dd>
              <dt>Origin</dt><dd>{dossier?.originAirportName || dossier?.originAirport || "—"}</dd>
              <dt>Destination</dt><dd>{dossier?.destinationAirportName || dossier?.destinationAirport || "—"}</dd>
            </dl>
            <button className="details-panel-close" onClick={() => setSelected(null)} aria-label="Close aircraft details">
              Close
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
