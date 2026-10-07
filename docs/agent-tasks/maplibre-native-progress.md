# MapLibre-native migration: progress log

Brief: `docs/agent-tasks/maplibre-native.md`. Branch: `feat/maplibre-native`.
Stage B in progress; Stage C (planes as a GL layer) not started.

## Done (Stage B)

- One plain `maplibregl.Map` (`src/map/map.ts`), wrapped in the `FlightMap`
  adapter: app (Leaflet) zoom units = MapLibre zoom + 1, `[lat, lon]`
  positions, container pixels. Tests reach it as `._flightMap` on
  `.map-container`.
- Native wheel/touchpad/pinch: `setWheelZoomRate(1 / 113.5)` (one 100 px
  notch is about half a level), touchpad rate default, no rotation or
  pitch, `renderWorldCopies: false`, `maxBounds` for the world (longitudes
  pulled in by 1e-9: at exactly ±180 MapLibre computes a 0 px wide world and
  zooms to infinity), minimum zoom from `zoomLimits.ts`, re-fit on resize.
- `basemapReady` is the map's first `idle`, capped (`maplibreBasemap.ts`).
  Deleted: `wheelZoom.ts`, `pinchResolution.ts`, the zoom-out patch, the
  blank TileLayer, the ±1 warm-up. Removed `leaflet`,
  `@maplibre/maplibre-gl-leaflet`, `@types/leaflet` and the unpkg CSS link.
  maplibre-gl is a static import, in its own `maplibre` chunk
  (`vite.config.ts` manualChunks).
- Planes: one `maplibregl.Marker` per drawn plane. The Marker's element is a
  bare `.plane-marker` wrapper around today's `.plane-icon` markup (the
  Marker writes inline opacity on its element, which would override the
  dimmed/exiting CSS). Reuse by icao24 and `MAX_DRAWN_MARKERS` kept; restyle
  in place on zoom. z-index: dimmed 0, normal 1, selected 2, airports 3.
- Fractional zoom: icon sizes round (as before); overview requests and
  their cache key use `overviewZoom()` (nearest whole level below 8);
  prefetch uses `Math.round(zoom) ± 1`; the /live vs overview threshold
  stays on the raw zoom (so /live is never requested below 8).
- Trail (`map/route.ts`): GeoJSON source `flight-route` + line layer
  `flight-route-line`, colour from `--color-accent`. The SVG dash-travel
  animation is gone (a GL line is drawn dashed but static).
- Airports: `.default-airport-icon` DOM markers. Scale bar: a MapLibre
  control (bottom-left). Debug overlay, follow-selected, initial view and
  off-screen check ported to the adapter.
- Tests: helpers and every spec migrated off `.leaflet-*` and Leaflet
  methods. Replaced `wheel-zoom`, `pinch-resolution`,
  `basemap-zoom-coverage`, `basemap-warmup` with `map-zoom.spec.ts`
  (notch ≈ 0.5, fast notches all count, ctrl+wheel stream is continuous,
  zoom around pointer, canvas covers the viewport while zooming, whole-level
  data keys) and `basemap-ready.spec.ts`; `pinch-zoom.spec.ts` gained the
  "ends fractional" case. The five timing failures from the first commit:
  boot screen intercepting forced clicks (stale-dim), a racy prefetch count
  (now counts per level), attribution width (box-sizing), and a 0 px read
  of a re-rendering panel (polled).
- `CLAUDE.md` / `README.md` updated (one theme, the adapter, zoom units).

## Next

- Run `test:perf` and `test:scenarios`; fix what they find.
- Backend `mvn -B verify -Pwith-frontend`.

## Known failures

- (none recorded yet beyond the cloud-only `production-build.spec.ts`
  real-tile check)
