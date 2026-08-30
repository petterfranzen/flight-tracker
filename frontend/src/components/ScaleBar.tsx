import { useEffect } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";
import "./ScaleBar.css";

// Fixed number of 1cm ruler segments — a classic surveyor's-scale look
// (alternating light/dark blocks, each a constant physical size) rather
// than Leaflet's default ScaleControl, which instead keeps the bar's
// *pixel width* constant and rounds the *distance* to a "nice" number.
// 5 reads clearly at the sizes tested; drop to 3 if it ever proves too
// wide for a narrower target layout.
const SCALE_SEGMENT_COUNT = 5;

// CSS's own definition of a physical unit: 96px = 1in (the CSS Pixel
// spec), so 1cm = 96 / 2.54 px. No browser API can read a display's true
// DPI, so — like every "cm" ruler on the web — this is nominal: accurate
// on a standard 96dpi-calibrated display, approximate on anything a
// browser/OS scales differently (a phone's real pixel density, a
// non-default OS display-scaling setting, etc.).
const CSS_PX_PER_CM = 96 / 2.54;

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

// Labels share one unit across the whole bar (picked from the *total*
// distance, not per-tick) and only the last one carries the unit suffix —
// each tick's own CSS_PX_PER_CM (~38px) of horizontal room can't fit
// "141 km" next to "188 km" next to "235 km" all with their own suffix,
// but bare "141", "188", "235 km" fits comfortably.
function formatSegmentLabels(kmPerSegment: number, count: number): string[] {
  const totalKm = kmPerSegment * count;
  const useMeters = totalKm < 1;
  const unit = useMeters ? "m" : "km";
  const toUnit = (km: number) => (useMeters ? km * 1000 : km);
  const decimals = !useMeters && totalKm < 10 ? 1 : 0;
  return Array.from({ length: count + 1 }, (_, i) => {
    const value = toUnit(kmPerSegment * i);
    const formatted = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
    return i === count ? `${formatted} ${unit}` : formatted;
  });
}

/**
 * A fixed-physical-size ruler — SCALE_SEGMENT_COUNT segments, each
 * CSS_PX_PER_CM wide on screen — replacing Leaflet's default ScaleControl.
 * Segment distances aren't round numbers (a segment is just "whatever
 * distance 1cm covers at this zoom/latitude"), but the bar's physical size
 * answers "how big is Xcm on the map" directly and consistently across
 * zoom levels, which is the point of a ruler.
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
    const labels: HTMLSpanElement[] = [];

    control.onAdd = () => {
      const container = L.DomUtil.create("div", "scale-bar");
      L.DomEvent.disableClickPropagation(container);

      const track = L.DomUtil.create("div", "scale-bar-track", container);
      track.style.width = `${SCALE_SEGMENT_COUNT * CSS_PX_PER_CM}px`;

      const labelRow = L.DomUtil.create("div", "scale-bar-labels", container);
      labelRow.style.width = `${SCALE_SEGMENT_COUNT * CSS_PX_PER_CM}px`;

      labels.length = 0;
      for (let i = 0; i < SCALE_SEGMENT_COUNT; i++) {
        const seg = L.DomUtil.create(
          "div",
          `scale-bar-segment${i % 2 === 0 ? " scale-bar-segment--alt" : ""}`,
          track,
        );
        seg.style.width = `${CSS_PX_PER_CM}px`;
      }

      for (let i = 0; i <= SCALE_SEGMENT_COUNT; i++) {
        const label = L.DomUtil.create("span", "scale-bar-label", labelRow);
        label.style.left = `${i * CSS_PX_PER_CM}px`;
        labels.push(label);
      }

      return container;
    };

    control.addTo(map);

    function update() {
      const kmPerSegment = (metersPerPixel(map) * CSS_PX_PER_CM) / 1000;
      const text = formatSegmentLabels(kmPerSegment, SCALE_SEGMENT_COUNT);
      labels.forEach((label, i) => {
        label.textContent = text[i];
      });
    }

    update();
    map.on("move zoom", update);

    return () => {
      map.off("move zoom", update);
      control.remove();
    };
  }, [map]);

  return null;
}
