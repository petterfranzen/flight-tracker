# MapLibre-native map (drop Leaflet)

Branch: `feat/maplibre-native` (first commit: cyberpunk is the only theme).
Why: the zoom review (https://claude.ai/artifact/JreBpBKXqqdnJqch8yozxX)
found that zoom feels bad because of Leaflet's model: whole-level zoom
steps, a CSS-scaled snapshot of the basemap during zoom animations, a snap
back to a whole level after a pinch, and our own stepped wheel handler that
drops input. MapLibre on its own zooms continuously, redraws every frame and
handles wheel, touchpad and pinch natively. The owner chose to drop the
plain theme and move everything to MapLibre.

Two stages, one PR each. Stage B is the one that fixes the feel.

## Stage B: one MapLibre map, no Leaflet

Replace the Leaflet map and the `maplibre-gl-leaflet` bridge with a plain
`maplibregl.Map` using `CYBERPUNK_STYLE`. Planes stay DOM elements in this
stage (`maplibregl.Marker` with today's `.plane-icon` markup), so styling and
most DOM-based tests carry over.

### Rules

- **Zoom units stay Leaflet's.** Everything outside the map layer (the
  backend's `zoom`/`gridDeg`, `CLUSTER_FETCH_MAX_ZOOM = 8`,
  `ICON_SIZE_BY_ZOOM`, `SELECTED_MIN_ZOOM`, `GROUND_SELECTED_ZOOM`,
  `zoomLimits.ts`, view caches, tests) speaks Leaflet zoom, which is
  MapLibre zoom + 1 (512 px vs 256 px tiles). Put the conversion in one
  place: a small adapter in `src/map/map.ts` (`getZoom()`, `setView()`,
  `flyTo()`, `getBounds()`, `project()` and so on in app units). Nothing
  else touches `maplibregl.Map` zoom directly.
- **Zoom is fractional now.** Anything that uses zoom as a key or an index
  must round: `main.ts` view caches (`z === zoom`), prefetch
  (`Math.round(zoom) + dz`), `markers.ts` already rounds for icon sizes,
  `defaultAirports.ts` floors. Fetch requests keep sending a whole zoom.
- **Native interaction, tuned:** `scrollZoom` on, with
  `setWheelZoomRate` so one 100 px mouse-wheel notch is about 0.5 levels
  (MapLibre's default is about 0.15). Keep the touchpad rate default.
  `dragRotate` and `touchZoomRotate` rotation off, `pitchWithRotate` off,
  `renderWorldCopies: false`, `maxBounds` for the world and the minimum zoom
  from `zoomLimits.ts` (re-fit on resize, as today).
- **Delete, don't port:** `map/wheelZoom.ts`, `map/pinchResolution.ts`,
  `patchZoomOutAnimation`, `lowerResolutionWhilePinching`, the blank
  `TileLayer`, `whenBasemapReady`'s ±1 zoom warm-up (it also had a race
  where the basemap returned to a stale centre). `basemapReady` becomes the
  map's first `idle` (with the existing time cap). Remove `leaflet`,
  `@maplibre/maplibre-gl-leaflet`, `@types/leaflet` and the unpkg
  `leaflet.css` link in `index.html`. MapLibre can be a static import now
  (there is no other theme for it to stay out of).
- **Planes:** `maplibregl.Marker({ element })` per drawn plane, element built
  by the existing icon code (`RotatingPlaneIcon` logic, classes
  `.plane-icon`, `--selected`, `--dimmed`, `.plane-icon-label`,
  `.plane-glyph` rotation). Keep the reuse-by-icao24 model in
  `createMarkerLayer` and the caps (`MAX_DRAWN_MARKERS`). Declutter keeps
  working off `project()` in container pixels. Re-pick planes on `moveend`
  only (MapLibre fires it once per gesture), never per frame.
- **Trail** (`map/route.ts`): a GeoJSON source + `line` layer (real points)
  and the movable tip, same colours via the CSS tokens' values. Selected
  plane always on top.
- **Airports** (`ui/defaultAirports.ts`): keep `.default-airport-icon` DOM
  markers in this stage (the scenario suite clicks them).
- **Scale bar, debug overlay, follow-selected, initial view, off-screen
  check:** port to the adapter.
- **Test hook:** tests reach the map through the container (today
  `._leaflet_map`). Expose the adapter as `._flightMap` on the map container
  and migrate `tests/helpers.ts` (`withMap`, `setMapView`,
  `__findLeafletMap`) and every spec using `.leaflet-*` selectors or Leaflet
  methods. Keep test intent; replace mechanics.
- **Tests to replace, not port:** `wheel-zoom.spec.ts` (stepper),
  `pinch-resolution.spec.ts`, `basemap-zoom-coverage.spec.ts` (zoom-out
  patch), `basemap-warmup.spec.ts`. New tests: one wheel notch zooms about
  0.5 and fractionally; several fast notches all count; a touchpad
  ctrl+wheel stream zooms continuously; a touch pinch ends at a fractional
  zoom (no snap); data requests still use whole zooms.
- `CLAUDE.md`: update the theme bullet (cyberpunk only) and mention the
  adapter and zoom units.

### Done when

`npm run build && npm run test:e2e && npm run test:perf && npm run test:scenarios`
pass (only `production-build.spec.ts`'s real-tile check may fail in a cloud
session), and `cd backend && mvn -B verify -Pwith-frontend` still passes.
The perf budget must not be loosened without a measured reason in the
commit message. Push to `feat/maplibre-native`; never to `main`.

## Stage C: planes as a GL layer

Move planes from DOM markers to a GeoJSON source + `symbol` layer
(`icon-rotate` from heading, `icon-size` interpolated by zoom, selected
plane in its own layer on top, dimmed via paint opacity). Click and hover
via `queryRenderedFeatures`. Replace `declutter.ts` with MapLibre's symbol
collision (`icon-allow-overlap: false`, `symbol-sort-key` = discovery
rank, active before inactive) if it matches today's "first discovered
wins"; otherwise keep the server-side cell thinning and let collision do
the screen-space part. Tests switch from `.plane-icon` DOM queries to a
test hook that lists rendered plane features. Separate PR after B merges.
