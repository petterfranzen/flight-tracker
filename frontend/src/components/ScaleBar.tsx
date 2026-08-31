import { useEffect } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";
import "./ScaleBar.css";

// Round distances only — picking from this ladder (rather than "whatever
// distance N px happens to cover") is what keeps the label from looking
// like meaningless noise (e.g. "141 km") and, combined with only
// recomputing on zoom (see the "zoomend"-only listener below), is what
// keeps the bar from visibly changing while panning: Mercator's
// meters-per-pixel varies with latitude at a fixed zoom, but that
// variation only rarely crosses a boundary between two of these values,
// so the label reads as stable across a pan even though the true
// underlying distance is still drifting slightly underneath it.
//
// Extends below 1km too (down to 1m): a flight tracker's normal zoom
// range never needs that, but Leaflet still allows zooming in close
// enough that even 1km would overflow the bar's max width — without a
// smaller rung to fall back to, pickScale's "largest that fits" logic has
// nothing to pick and the bar overflows the whole screen (seen live while
// testing this).
const BREAKPOINTS_KM = [0.001, 0.01, 0.1, 1, 10, 100, 1_000, 10_000];

// Target on-screen width for the bar — the actual width varies with
// whichever breakpoint above ends up chosen (see pickScale), same as
// Leaflet's own default ScaleControl.
const MAX_BAR_WIDTH_PX = 100;

// Sampled this many CSS px apart when reading the map's actual
// meters-per-pixel at the current zoom/latitude (via map.distance — the
// same technique Leaflet's own L.Control.Scale uses internally). Small
// samples are noisier from projection/floating-point rounding; this is a
// comfortable width to average over without being a large fraction of a
// typical viewport.
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
 * breakpoint down. Falls back to the smallest/largest breakpoint at either
 * extreme (an undersized bar when even 10,000km fits well within the max)
 * rather than inventing a value outside the ladder.
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
 * A single-bar scale indicator — replacing an earlier fixed-physical-size
 * ruler design that computed "whatever distance 1cm covers" per segment.
 * That approach recomputed (and visibly changed) on every pan, since
 * meters-per-pixel depends on latitude under Mercator, not just zoom — and
 * its segment distances were arbitrary, unrounded numbers. This version
 * only reacts to "zoomend" (panning to a different latitude no longer
 * moves the bar at all) and snaps to BREAKPOINTS_KM so the label is always
 * a clean, recognizable number.
 *
 * Built as an imperative L.Control (like Leaflet's own ScaleControl)
 * rather than plain positioned JSX: that gets correct corner-stacking
 * behavior with any other Leaflet controls sharing this corner for free,
 * instead of reimplementing it.
 */
export default function ScaleBar() {
  const map = useMap();

  useEffect(() => {
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

    function update() {
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
  }, [map]);

  return null;
}
