# B1 behaviour inventory — FlightMap.tsx (and friends) port to vanilla TS

Ticked as each behaviour lands in the vanilla port. Source: `frontend/src/components/FlightMap.tsx` (1761 lines) plus `DefaultAirports.tsx`, `MaplibreBasemap.tsx`, `BootScreen.tsx`, `Dock.tsx`, `FavoritesPanel.tsx`, `FlightSearch.tsx`, `Legend.tsx`, `ScaleBar.tsx`, `ThemeToggle.tsx`.

## Constants / pure helpers (must survive byte-for-byte in meaning)
- [x] `FETCH_INTERVAL_MS = 72_000`, `FETCH_STOP_MS = 5*60_000`, `DIALOG_STOP_MS = 5*60_000`
- [x] `ROUTE_COLOR`, `ROUTE_SPLINE_SEGMENTS = 8`, `smoothRoute` (Catmull-Rom)
- [x] `BLANK_TILE_URL` data-URI tile for cyberpunk theme's still-mounted TileLayer
- [x] `PLANE_SVG` dart glyph
- [x] `ICON_SIZE=30`, `SELECTED_ICON_SIZE=44`, `MOBILE_BREAKPOINT_PX=768`, `MOBILE_ICON_SIZE=40`, `MOBILE_SELECTED_ICON_SIZE=54`
- [x] `RotatingPlaneIcon`-equivalent: heading applied on icon creation via a live ref, not baked in
- [x] `planeIcon()`: known/selected/zoom/entering/exiting -> DivIcon w/ class list, aria-label, sizing via `scaleIconSize`
- [x] `boundsFromMap` incl. whole-world-span clamp to [-180,180]
- [x] `SELECTED_MIN_ZOOM=10`, `CLUSTER_FETCH_MAX_ZOOM=8`, `MAX_INDIVIDUAL_MARKERS=500`, `CLUSTER_TARGET_PX=110`
- [x] `gridDegForZoom`, `clusterPositions` (client-side bucketing, mirrors backend)
- [x] `MIN_ICON_SIZE_PX=9`, `FULL_SIZE_ZOOM=SELECTED_MIN_ZOOM`, `scaleIconSize` linear falloff
- [x] `STALE_POSITION_WARN_MS=10*60_000`, `formatAgo`, `formatDurationMinutes`, `FLIGHT_PHASE_LABELS`, `formatFlightPhase`, `formatAirport`
- [x] `CLUSTER_ICON_MIN_PX=22`, `CLUSTER_ICON_MAX_PX=56`, `clusterIconSize` (sqrt scaling)
- [x] `clusterPlaneCount` (2/3/4 bucket by count), `clusterIcon`

## Map/viewport
- [x] L.Map creation: center [59.33,18.06], zoom 6, minZoom 2, maxBounds world, maxBoundsViscosity 1, zoomControl false, wheelPxPerZoomLevel 200, aria-label
- [x] Always-mounted TileLayer (blank data-uri tile on cyberpunk, OSM otherwise), `noWrap`
- [x] Lazy MaplibreBasemap on cyberpunk theme only (dynamic import), added/removed on theme toggle
- [x] Lazy DefaultAirports (dynamic import)
- [x] ScaleBar control (bottomleft), recompute on `zoomend` only, breakpoint ladder, formatLabel
- [x] ViewportReporter: report bounds+zoom on mount and on every `moveend`
- [x] FollowSelected: flyTo on new selection or Focus-Plane click (targetZoom = max(current, SELECTED_MIN_ZOOM), duration .8s); panTo (no zoom change) on mobile sheet expand/collapse toggle only; no recenter on ordinary position tick; off-screen tracking via moveend/zoomend -> `planeOffScreen`; `map.invalidateSize()` on every relevant change

## Aircraft markers
- [x] Reuse `L.Marker` per `icao24` (new module keeps a Map keyed by icao24, diff position/icon, no full teardown)
- [x] Icon cache keyed by (known, selected, roundedZoom, entering, exiting) — entering flag true only on first build per marker
- [x] Heading rotation applied directly to `.plane-glyph` transform on tick, without rebuilding icon/DOM
- [x] Callsign label set once at icon creation (never re-applied)
- [x] Selected marker rendered separately/last (topmost), own icon params (no `exiting`)
- [x] Unselected list excludes selected icao24
- [x] `exiting` fade class applied only when zoom < CLUSTER_FETCH_MAX_ZOOM (server-cluster crossfade case)
- [x] Click handler -> select aircraft (mutually exclusive w/ airport dossier)

## Clustering
- [x] Below CLUSTER_FETCH_MAX_ZOOM: fetch server clusters (`fetchLiveClusters`) instead of positions; `positions` state left untouched (stale markers fade via `exiting`)
- [x] MAX_INDIVIDUAL_MARKERS client-side backstop: bucket unselected list via `clusterPositions` when zoom>=CLUSTER_FETCH_MAX_ZOOM and count>500; no crossfade in this path (individual list skipped outright)
- [x] Cluster marker click: `setView(cluster, zoom+3, {animate:false})`

## Route / history
- [x] `appendRoutePoint`: strictly-older observedAt rejected, identical-coordinate no-op, else append + setRoute
- [x] `smoothRoute` applied only for rendering, recomputed on route change
- [x] Route cleared + refs reset unconditionally on every selection change (incl. A->B direct)
- [x] History fetch (`fetchHistory`, last 6h) per selection; cancellation flag so a stale response after a newer selection is dropped
- [x] History filtered by `legStartAt` if already known; re-trim retroactively once dossier resolves after history
- [x] After history lands, append current `selectedPosRef` point to bridge gap to (possibly dead-reckoned) current position
- [x] Route polyline rendered only when `route.length > 1`, `path.route-line` class, ROUTE_COLOR/weight 3/dash "6 8"

## Data fetch / reconcile lifecycle
- [x] `isNewer` ordering by `observedAt` string compare
- [x] `applyLiveSnapshot`: sequence-guarded (`liveRequestSeqRef`) viewport fetch; merge guard vs. existing (WS-delivered) newer entries; updates `positionsRef`/positions; updates selected's `selectedPos` (merge, not replace) + appendRoutePoint; `.finally` sets firstLoadDone
- [x] `fetchForZoom`: cluster fetch vs individual fetch branch: this file's `zoom < CLUSTER_FETCH_MAX_ZOOM` sets `firstLoadDone` too, clears clusters otherwise
- [x] `fetchFreshData`: refreshes globalTrackedCount + fetchForZoom(bounds, zoom) if bounds known
- [x] `handleViewportChange`: updates bounds/zoom refs+state, calls fetchForZoom
- [x] `startCycle`: reset cycleStart, hide resume dialog, best-effort `restartPolling()`, fetchFreshData, bump cycleGeneration
- [x] Mount-only effect: `fetchPollingStatus` -> `restartPolling()` if inactive (idempotent, doesn't reset an already-open window); initial `fetchLiveCount`
- [x] Fetch-interval effect (keyed on cycleGeneration): every FETCH_INTERVAL_MS call fetchFreshData until FETCH_STOP_MS elapsed since cycle start, then stop
- [x] Dialog-timer effect (keyed on cycleGeneration): at DIALOG_STOP_MS since cycle start, silently `restartPolling()`; on rateLimited -> show ResumeDialog; on success -> reset cycle silently (bump generation); on network error -> show dialog too
- [x] WebSocket subscribe: ignore frames superseded by a fresher stored position (`isNewer` guard); update positions map; if selected icao24 matches, update selectedPos + appendRoutePoint; capped exponential backoff reconnect (1s->30s) [NEW behaviour per B1.5, not in the React version] ; ignore keepalive frames
- [x] `nowMs` ticked every 1s only while an aircraft is selected (drives "last updated" display)
- [x] Dedicated priority poll for selected aircraft (`fetchFlightLive`) every FETCH_INTERVAL_MS, immediate on select, continues past FETCH_STOP_MS, cancelled on deselect/reselect; guards: response must match currently-selected icao24, must be newer than existing

## Selection / dossier
- [x] `handleSelect`: clears airport dossier, sets selected icao24, seeds selectedPos (preserve altitude if reselecting same aircraft), collapses dossier sheet
- [x] `handleAirportSelect`: clears aircraft selection, sets airport dossier immediately from click data, fetches `fetchAirportInfo` best-effort, collapses sheet
- [x] Aircraft dossier fetch (`fetchAircraftDossier`) on selection change, cancelled on newer selection; sets `legStartAt` ref; clears dossier immediately while in flight
- [x] Favorite toggles: aircraft (icao24/registration/callsign) and route (origin/destination w/ names+iata), both persisted via favorites.ts; toggle functions stable/pure
- [x] Favorite state derived: `selectedAircraftFavorited`, `selectedRouteFavorited` (route only computable once dossier has both airports)
- [x] Details panel: header/eyebrow, callsign/icao fallback heading, Focus-Plane button only when `planeOffScreen`, favorite toggle buttons (aria-pressed, disabled+title when route unknown), meta line, stale/last-updated line w/ dossier.staleExplanation, fields dl (Type/Registration/Operator/Origin/Destination/Phase/Altitude clamped>=0/Cruising altitude/Flight time/ETA), expand/collapse toggle (mobile), close buttons (X and text)
- [x] Airport details panel: header/eyebrow, name/code heading, iata/icao meta, fields dl (Municipality/Country/Latitude/Longitude), expand/collapse toggle, close buttons
- [x] Panels are mutually exclusive; Dock hidden whenever either panel open

## Theme
- [x] `loadTheme`/`saveTheme`/`applyTheme` (unchanged file) drive which basemap layer mounts (TileLayer url/attribution + Maplibre layer presence), not just CSS
- [x] ThemeToggle button reflects/drives theme state
- [x] Tracked-chip only rendered in cyberpunk theme, shows `globalTrackedCount.toLocaleString()`
- [x] BootScreen only mounted in cyberpunk theme; gated on `firstLoadDone`; MIN_VISIBLE_MS=2600 floor; status line cycling every 700ms; progress bar fill animation (reduced-motion tick 260 vs 170ms) capped at 92% until ready, then 100% + 450ms hide delay; noise/scanline decorative divs generated once

## Other components ported as-is (behaviourally)
- [x] Dock: hidden when a details panel is open; Search/Favorites tiles proxy-click the real controls; Details/Layers tiles disabled
- [x] FlightSearch: debounced (250ms) callsign search w/ sequence guard, keyboard nav (Escape/ArrowUp/ArrowDown/Enter), mouse hover/active state, outside-pointerdown-closes; identical "advanced" airport search panel w/ its own debounce/sequence guard/keyboard nav; mobile FAB/panel open state; choosing a result resets all query/open state on both search modes
- [x] FavoritesPanel: open/closed state; live-check refresh loop every 20s while open only (aircraft via fetchFlightLive, routes via two searchFlightsByAirport calls intersected by icao24); mobile FAB + close button; item select/remove; label fallback chain
- [x] Legend: collapsible, static swatch rows, mobile FAB pattern
- [x] ScaleBar: as above (moved under Map behaviours)
- [x] ThemeToggle: as above
- [x] DefaultAirports: lazy; zoom-bucketed visibility via `MAX_RANK_BY_ZOOM`, recomputed on `zoomend` only; dedicated pane (`airport-overlay`, z-index 650) created idempotently before any marker mounts; per-airport DivIcon w/ dot+IATA label; click -> `onAirportSelect`
- [x] MaplibreBasemap: `setWorkerUrl` call preserved; layer added to map on mount/theme-select, removed on unmount/theme-change; CYBERPUNK_STYLE unchanged import

## WebSocket (B1.5, new requirement beyond straight port)
- [x] Reconnect with capped exponential backoff 1s -> 30s
- [x] Ignore keepalive frames (coordinate: A1 sends `{"type":"ping"}` or server ping frame per hand-off; frontend ignores non-FlightPosition-shaped frames)

## Build / bundling
- [x] MapLibre basemap stays a separate lazy chunk (dynamic import), not in main bundle
- [x] DefaultAirports (and worldMapData) stays a separate lazy chunk
- [x] react/react-dom/react-leaflet/@types/react*/@vitejs/plugin-react removed from package.json
- [x] Vite config: react plugin dropped; optimizeDeps/worker/proxy config kept
- [x] tsconfig: jsx option removed, strict kept, `tsc -b` clean
