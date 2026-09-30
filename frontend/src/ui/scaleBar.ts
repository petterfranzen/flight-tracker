import L from "leaflet";
import "../components/ScaleBar.css";

// Round distances only, from a ladder — extends below 1km too (down to
// 1m): a flight tracker's normal zoom range never needs that, but Leaflet
// still allows zooming in close enough that even 1km would overflow the
// bar's max width.
const BREAKPOINTS_KM = [0.001, 0.01, 0.1, 1, 10, 100, 1_000, 10_000];
const MAX_BAR_WIDTH_PX = 100;
const SAMPLE_PX = 200;

function metersPerPixel(map: L.Map): number {
  const center = map.latLngToContainerPoint(map.getCenter());
  const p1 = map.containerPointToLatLng(center);
  const p2 = map.containerPointToLatLng(center.add(L.point(SAMPLE_PX, 0)));
  return map.distance(p1, p2) / SAMPLE_PX;
}

/**
 * The largest breakpoint whose bar would fit within MAX_BAR_WIDTH_PX, so
 * the bar grows as you zoom in until it'd overflow, then snaps to the next
 * breakpoint down.
 */
function pickScale(metersPerPx: number): { km: number; widthPx: number } {
  let chosen = BREAKPOINTS_KM[0];
  for (const km of BREAKPOINTS_KM) {
    const widthPx = (km * 1000) / metersPerPx;
    if (widthPx > MAX_BAR_WIDTH_PX) break;
    chosen = km;
  }
  return { km: chosen, widthPx: (chosen * 1000) / metersPerPx };
}

function formatLabel(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString()} km`;
}

/**
 * A single-bar scale indicator, built as an imperative L.Control (like
 * Leaflet's own ScaleControl) so it gets correct corner-stacking behavior
 * with any other Leaflet control sharing this corner for free. Only updates
 * on "zoomend" — panning to a different latitude doesn't move the bar at
 * all, which keeps the label from visibly changing while dragging even
 * though the true underlying meters-per-pixel is still drifting slightly
 * underneath it.
 */
export function mount(map: L.Map): () => void {
  const control = new L.Control({ position: "bottomleft" });
  let bar: HTMLDivElement;
  let label: HTMLSpanElement;

  control.onAdd = () => {
    const container = L.DomUtil.create("div", "scale-bar");
    L.DomEvent.disableClickPropagation(container);
    bar = L.DomUtil.create("div", "scale-bar-track", container);
    label = L.DomUtil.create("span", "scale-bar-label", container);
    return container;
  };
  control.addTo(map);

  function update(): void {
    const { km, widthPx } = pickScale(metersPerPixel(map));
    bar.style.width = `${widthPx}px`;
    label.textContent = formatLabel(km);
  }
  update();
  map.on("zoomend", update);

  return () => {
    map.off("zoomend", update);
    control.remove();
  };
}
