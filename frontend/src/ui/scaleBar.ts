import type { IControl } from "maplibre-gl";
import type { FlightMap } from "../map/map";
import "../components/ScaleBar.css";

// Round distances only, from a ladder — extends below 1km too (down to
// 1m): a flight tracker's normal zoom range never needs that, but the map
// still allows zooming in close enough that even 1km would overflow the
// bar's max width.
const BREAKPOINTS_KM = [0.001, 0.01, 0.1, 1, 10, 100, 1_000, 10_000];
const MAX_BAR_WIDTH_PX = 100;
const SAMPLE_PX = 200;

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
 * A single-bar scale indicator, mounted as a MapLibre control in the
 * bottom-left corner (so it stacks with anything else sharing that corner).
 * Updates on "zoom" only — panning to a different latitude doesn't move the
 * bar at all, which keeps the label from visibly changing while dragging
 * even though the true underlying meters-per-pixel is still drifting
 * slightly underneath it.
 */
export function mount(map: FlightMap): () => void {
  const container = document.createElement("div");
  container.className = "maplibregl-ctrl scale-bar";
  const bar = document.createElement("div");
  bar.className = "scale-bar-track";
  const label = document.createElement("span");
  label.className = "scale-bar-label";
  container.append(bar, label);
  const control: IControl = {
    onAdd: () => container,
    onRemove: () => container.remove(),
  };
  map.gl.addControl(control, "bottom-left");

  function update(): void {
    const { km, widthPx } = pickScale(map.metersPerPixel(SAMPLE_PX));
    bar.style.width = `${widthPx}px`;
    label.textContent = formatLabel(km);
  }
  update();
  map.on("zoom", update);

  return () => {
    map.off("zoom", update);
    map.gl.removeControl(control);
  };
}
