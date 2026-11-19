import type { AppStore } from "../state/appState";
import type { FlightMap, LatLon } from "../map/map";
import type { SelectedPosition, TrackStatus } from "../types/flight";
import { confirmedGate, displayedPosition, gateDisplay, GATE_MAX_DISTANCE_M, type GateDisplay, type GatePoint } from "../map/gatePlacement";
import { loadGateIndex, nearestGateOrStandFromIndex, nearestStandFromIndex } from "../map/gateIndex";

/**
 * The gate tracker: the state and functions that place and track the selected
 * aircraft's gate, split out of boot() with their comments.
 *
 * Inert at construction: nothing reads the store, the map or the index until a
 * method is called. Everything it needs from boot()'s closure — the store, the
 * map, the aircraft render, the trail redraw and the three gate constants —
 * arrives through a `deps` object of arrow callbacks and values, so this module
 * keeps no import of main.ts.
 */
export interface GateTrackerDeps {
  store: AppStore;
  map: FlightMap;
  /** Redraw the aircraft layer: the status can move the marker to its gate. */
  renderAircraftLayer: () => void;
  /** Redraw the trail: a gate display moves the point it ends at. */
  drawRoute: () => void;
  /** The app zoom from which the basemap's own gate points (zoom-14 tiles) are loaded. */
  GATE_TILE_ZOOM: number;
  /** Where the one-time fly-to to a confirmed gate goes. */
  GATE_LOOKUP_ZOOM: number;
  /** A provider ref the index does not carry, on a plane on the ground: snap to a stand within this. */
  STAND_SNAP_M: number;
}

export interface GateTracker {
  /** The gate display for the current selection, or null. */
  currentGateDisplay: () => GateDisplay | null;
  /** The selected plane's status changed: resolve, fly once, recentre. */
  onGateStatus: (status: TrackStatus | null) => void;
  /** Look the gate up again (a loaded tile may have answered). */
  resolveGate: () => Promise<void>;
  /** A new selection: forget everything about the previous one. */
  reset: () => void;
  /** The user moved the map: never fly them to a gate after this. */
  onUserMove: () => void;
  /** Start fetching the index chunk and answer whatever asked while it was in flight. */
  loadIndex: () => void;
}

export function createGateTracker(deps: GateTrackerDeps): GateTracker {
  const { store, map, renderAircraftLayer, drawRoute, GATE_TILE_ZOOM, GATE_LOOKUP_ZOOM, STAND_SNAP_M } = deps;

  // ---- confirmed gate ----
  // A plane whose gate a provider confirmed is drawn at the gate once its last
  // report is old (map/gatePlacement.ts). The gate's coordinate comes from the
  // static OSM index (gateIndex.ts), keyed by the landing airport, so it needs
  // no tile and resolves at any zoom; the basemap's own vector-tile gate points
  // are the fallback (map.ts findGate), looked up again whenever tiles load.
  let gatePoint: { icao24: string; gate: string; lat: number; lon: number } | null = null;
  // A guessed point for a gate the index and the tiles cannot place.
  // Deliberately not `gatePoint`: it never blocks a real gate, the tile lookup
  // or the one-time fly-to, and it is dropped the moment one of those answers.
  //  - `approximate: false`: a plane on the ground at the airport parked at a
  //    stand within STAND_SNAP_M. The label stays the provider's own ref: the
  //    dossier shows that ref, and a guessed stand name would contradict it.
  //  - `approximate: true`: the provider named a gate the index does not carry
  //    (87, F58 and F62 at ARN are in neither OSM's gate layer nor the index),
  //    so the nearest indexed gate or stand within GATE_MAX_DISTANCE_M stands
  //    in for it and the label says "Gate <ref>".
  let fallbackPoint: { icao24: string; lat: number; lon: number; approximate: boolean } | null = null;
  // Once per selection, if the gate's tile is not loaded: go where it is. Never against
  // the user: not after they moved the map since selecting, nor while it is moving.
  let gateZoomDone = false;
  let userMovedMap = false; // set by the map's user-move listener (below, once `map` exists)
  // The status moves the marker from its last report to its gate, which can put it
  // outside the view the selection just flew to (the two are not the same point).
  // Bring the camera to the drawn point so the selected plane is on screen — a pan,
  // not a fly, so the zoom the selection chose is kept.
  //
  // Only when a gate display actually applies: without one the marker is where its
  // last report says, and an ordinary position tick must not recentre the map (see
  // createFollowSelected). And only once per selection or gate change: the status
  // is refreshed every 15 s while coverage is lost and every 60 s for a landed
  // plane, and none of those later polls may move the camera again. Never against
  // the user: not after they moved the map, nor for a selection that changed while
  // the map was still moving.
  let gatePanKey: string | null = null; // "<selectedId>|<gate>" already brought into view

  /** True when `gatePoint` holds this gate's own point for this plane. */
  function gatePointMatches(pos: SelectedPosition | null, gate: string | null): boolean {
    if (!gate || !gatePoint) return false;
    return gatePoint.gate === gate && gatePoint.icao24 === pos?.icao24;
  }

  /** The point a gate display should use: the gate's own, else a guess for this plane, else null. */
  function pointFor(pos: SelectedPosition | null, gate: string | null): GatePoint | null {
    if (gatePointMatches(pos, gate)) return gatePoint;
    if (fallbackPoint && fallbackPoint.icao24 === pos?.icao24) return fallbackPoint;
    return null;
  }

  function currentGateDisplay(): GateDisplay | null {
    const pos = store.get("selectedPos");
    const status = store.get("trackStatus");
    const gate = confirmedGate(pos, status);
    return gateDisplay(pos, status, Date.now(), pointFor(pos, gate));
  }

  function onGateStatus(status: TrackStatus | null): void {
    // The index chunk may still be in flight, so decide the fly-to only after
    // the lookup has had its answer: an index hit must never drag the camera in.
    void resolveGate().then(() => {
      maybeFlyToGate(status);
      renderAircraftLayer(); // the status can also stop qualifying (a gate that changed)
      // ...and it can move the marker to its gate: bring it back if that left the view.
      keepSelectedInView(store.get("selectedId"));
      drawRoute();
    });
  }

  function maybeFlyToGate(status: TrackStatus | null): void {
    const pos = store.get("selectedPos");
    const gate = confirmedGate(pos, status);
    if (gateZoomDone) return;
    if (!status || !gate) return;
    if (gatePointMatches(pos, gate)) return;
    gateZoomDone = true;
    flyToGate(store.get("selectedId"), status.lastSeenLat, status.lastSeenLon);
  }

  /**
   * The selection's own camera move is usually still running when the status arrives: wait
   * for it to end, then decide. Whatever the user did meanwhile (or the gate resolving) wins.
   * Returns true while the rerun is pending, so the caller can stop this attempt.
   */
  function onMapSettles(fn: () => void): boolean {
    if (!map.isMoving()) return false;
    const retry = () => {
      map.off("moveend", retry);
      fn();
    };
    map.on("moveend", retry);
    return true;
  }

  function gateLookupBlocked(selectedId: string | null): boolean {
    if (store.get("selectedId") !== selectedId) return true;
    return userMovedMap || gatePoint !== null;
  }

  function flyToGate(selectedId: string | null, lat: number, lon: number): void {
    if (onMapSettles(() => flyToGate(selectedId, lat, lon))) return;
    if (gateLookupBlocked(selectedId)) return;
    // The gate tiles are already in reach (zoom, and the plane in view): the gate is not in
    // the basemap, and no camera move can change that.
    if (map.getZoom() >= GATE_TILE_ZOOM && map.contains(lat, lon)) return;
    map.flyTo([lat, lon], GATE_LOOKUP_ZOOM, 800);
  }

  function keepSelectedInView(selectedId: string | null): void {
    if (onMapSettles(() => keepSelectedInView(selectedId))) return;
    // The id is the caller's, not a fresh read: `selectedId` here is what this call
    // was made for, so the comparison can actually fail while the map was moving.
    if (!panInputValid(selectedId)) return;
    const gate = currentGateDisplay();
    if (!gate) return; // no gate display: nothing moved the marker, so nothing to bring back
    const key = `${selectedId}|${gate.gate}`;
    if (gatePanKey === key) return; // already handled for this selection and gate
    const pos = store.get("selectedPos");
    if (!pos) return;
    gatePanKey = key;
    const drawn = displayedPosition(pos, gate);
    if (!map.contains(drawn.latitude, drawn.longitude)) map.panTo([drawn.latitude, drawn.longitude], 500);
  }

  /** The selection this recentre is still about, and not one the user has taken over. */
  function panInputValid(selectedId: string | null): boolean {
    if (!selectedId || userMovedMap) return false;
    return store.get("selectedId") === selectedId;
  }

  /**
   * The dossier's gate line says when the marker is at a guess rather than the
   * gate itself. Set wherever the display can change; the store set is a no-op
   * unless it flips, so the panel is not rebuilt on every tile event.
   */
  function syncGateApproximate(): void {
    const approximate = currentGateDisplay()?.approximate === true;
    if (store.get("gateApproximate") !== approximate) store.set("gateApproximate", approximate);
  }

  async function resolveGate(): Promise<void> {
    await loadGateIndex(); // a no-op once the chunk has landed
    const pos = store.get("selectedPos");
    const status = store.get("trackStatus");
    if (!pos || !status) return clearFallbackPoint();
    const gate = confirmedGate(pos, status);
    if (!gate) return clearFallbackPoint();
    if (!gatePointMatches(pos, gate)) resolveAtGate(pos, status, gate);
    syncGateApproximate();
    renderAircraftLayer();
    drawRoute();
  }

  // The status stopped qualifying (the plane moved on, the provider dropped
  // the gate): a guess from before is no longer about this plane.
  function clearFallbackPoint(): void {
    fallbackPoint = null;
    syncGateApproximate();
  }

  function resolveAtGate(pos: SelectedPosition, status: TrackStatus, gate: string): void {
    const near = { lat: status.lastSeenLat, lon: status.lastSeenLon };
    const icao = status.landing?.airportIcao;
    const found = map.findGate(gate, near, icao);
    if (found) {
      gatePoint = { icao24: pos.icao24, gate, lat: found.lat, lon: found.lon };
      fallbackPoint = null;
      return;
    }
    // The ref is in neither the index nor a loaded tile. Two guesses, both
    // dropped the moment a real gate answers:
    //  - an on-ground plane may be parked at a stand within STAND_SNAP_M (the
    //    label stays the provider's ref). The index needs no tile, so this
    //    does not wait for the view to reach the airport;
    //  - otherwise the plane is somewhere in the airport's terminal area, so
    //    the nearest indexed gate or stand within GATE_MAX_DISTANCE_M stands
    //    in for the unmapped gate, labelled "Gate <ref>".
    // Re-guessed on every resolve, never once per selection: a plane that
    // taxis after the first status moves to another stand, and the marker
    // must follow it. Both lookups are in-memory scans of the loaded index.
    fallbackPoint = guessFallback(pos, icao, near);
  }

  function guessFallback(pos: SelectedPosition, icao: string | undefined, near: LatLon): { icao24: string; lat: number; lon: number; approximate: boolean } | null {
    const stand = pos.onGround === true ? nearestStandFromIndex(icao, near, STAND_SNAP_M) : null;
    if (stand) return { icao24: pos.icao24, lat: stand.lat, lon: stand.lon, approximate: false };
    const area = nearestGateOrStandFromIndex(icao, near, GATE_MAX_DISTANCE_M);
    return area ? { icao24: pos.icao24, lat: area.lat, lon: area.lon, approximate: true } : null;
  }

  function reset(): void {
    gatePoint = null;
    fallbackPoint = null;
    gateZoomDone = false;
    gatePanKey = null;
    userMovedMap = false;
  }

  function onUserMove(): void {
    userMovedMap = true;
  }

  function loadIndex(): void {
    void loadGateIndex().then(() => resolveGate());
  }

  return { currentGateDisplay, onGateStatus, resolveGate, reset, onUserMove, loadIndex };
}
