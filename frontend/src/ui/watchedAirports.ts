import type { AppStore } from "../state/appState";
import type { FlightMap, RenderedWatchedAirport } from "../map/map";
import type { ScheduledFlight } from "../api/flightApi";
import { watchKey, type WatchedFlight } from "../watchlist";
import { AIRPORTS } from "../worldMapData";
import { canvas, cssToken, drawLabel, measureLabel, serveImages, type LabelStyle } from "../map/glImages";

/**
 * Where a not-yet-airborne watched flight still is, on the map: its origin
 * airport ringed and labelled with the flight number, the scheduled time and
 * the estimate. One feature per such flight, drawn as its own symbol layer
 * over the airports; a flight that has gone airborne drops off (its plane is
 * drawn instead - see map/planes.ts).
 *
 * Loaded lazily (main.ts) so worldMapData.ts's ~160KB stays out of the main
 * bundle, same as ui/defaultAirports.ts.
 */

const SOURCE = "watched-origins";
const LAYER = "watched-origins";
const IMAGE_PREFIX = "watched-origin:";
// The ring around the airport, and where the label chip starts. The gap is
// wide enough to clear the airport layer's own code chip, which is drawn to
// the right of the dot (this layer sits under it).
const RING_PX = 20;
const LABEL_X_PX = 44;

const timeOf = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" }) : "–";

interface Origin {
  code: string;
  lat: number;
  lon: number;
  flightNumber: string;
  text: string;
}

/** The origin of a not-airborne watched flight: its departure airport from the bundled AIRPORTS data, plus the label text. */
function originOf(w: WatchedFlight, row: ScheduledFlight | null): Origin | null {
  const code = row?.departureIata ?? null;
  if (!code) return null;
  const ap = AIRPORTS.find((a) => a.code === code);
  if (!ap) return null;
  const est = row?.estimated && row.estimated !== row.scheduled ? ` → est ${timeOf(row.estimated)}` : "";
  // No IATA code in the text: the airport layer's own code chip already sits
  // right of the dot, and this label leaves that room (see LABEL_X_PX).
  return { code, lat: ap.pos[1], lon: ap.pos[0], flightNumber: w.flightNumber, text: `${w.flightNumber} · dep ${timeOf(row?.scheduled ?? null)}${est}` };
}

export function mount(map: FlightMap, store: AppStore): () => void {
  const gl = map.gl;
  let added = false;
  let destroyed = false;
  let features: GeoJSON.Feature[] = [];

  map.whenStyleReady(() => {
    if (destroyed) return;
    const color = cssToken("--color-marker-watched", "#22d3a6");
    const label: LabelStyle = {
      font: `700 11px ${cssToken("--font-data", "monospace")}`,
      color,
      background: cssToken("--color-label-bg", "rgba(5, 6, 8, 0.65)"),
      padX: 5,
      padY: 2,
      radius: 3,
    };
    serveImages(
      map,
      IMAGE_PREFIX,
      (text) => {
        const m = measureLabel(text, label);
        const height = Math.max(RING_PX, m.height);
        const width = LABEL_X_PX + m.width;
        const { ctx, done } = canvas(width, height, Math.max(2, window.devicePixelRatio || 1));
        // The hotspot ring, centred on the airport (icon-offset puts its centre there).
        const r = RING_PX / 2;
        ctx.beginPath();
        ctx.arc(r, height / 2, r - 2, 0, 2 * Math.PI);
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        drawLabel(ctx, text, label, LABEL_X_PX, (height - m.height) / 2);
        return done();
      },
      label.font,
    );

    gl.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features } });
    gl.addLayer(
      {
        id: LAYER,
        type: "symbol",
        source: SOURCE,
        layout: {
          "icon-image": ["concat", IMAGE_PREFIX, ["get", "text"]],
          "icon-anchor": "left",
          // The ring's centre sits on the airport; the label runs off to the right.
          "icon-offset": [-RING_PX / 2, 0],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
      gl.getLayer("airports") ? "airports" : undefined,
    );
    added = true;
  });

  /** Rebuilds the drawn set from the store: the origin of every watched flight that has not gone airborne yet. */
  function update(): void {
    const status = store.get("watchedStatus");
    const watched = store.get("watchedFlights");
    const origins: Origin[] = [];
    for (const w of watched) {
      const row = status[watchKey(w)] ?? null;
      if (row?.airborne) continue; // airborne: its plane is the marker now
      const o = originOf(w, row);
      if (o) origins.push(o);
    }
    features = origins.map((o) => ({
      type: "Feature",
      properties: { code: o.code, flightNumber: o.flightNumber, text: o.text },
      geometry: { type: "Point", coordinates: [o.lon, o.lat] },
    }));
    if (added) (gl.getSource(SOURCE) as unknown as { setData(d: unknown): void }).setData({ type: "FeatureCollection", features });
  }

  const unsubscribe = store.subscribeMany(["watchedFlights", "watchedStatus"], update);
  update();

  map.renderedWatchedAirports = (): RenderedWatchedAirport[] => {
    if (!added) return [];
    const out: RenderedWatchedAirport[] = [];
    for (const f of gl.queryRenderedFeatures({ layers: [LAYER] })) {
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const { code, flightNumber } = f.properties as { code: string; flightNumber: string };
      const at = map.project(lat, lon);
      out.push({ code, flightNumber, lat, lon, x: at.x - RING_PX / 2, y: at.y });
    }
    return out;
  };

  return () => {
    destroyed = true;
    unsubscribe();
    if (added && gl.getStyle()) {
      gl.removeLayer(LAYER);
      gl.removeSource(SOURCE);
    }
    added = false;
    map.renderedWatchedAirports = () => [];
  };
}
