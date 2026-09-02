# Code & Performance Review: `feature/cyberpunk-theme-toggle`

## Executive Summary

The `feature/cyberpunk-theme-toggle` branch introduces a switchable Cyberpunk 2077 aesthetic, featuring a custom 2D Canvas vector basemap (`VectorBasemap.tsx`), a UI theme toggle (`ThemeToggle.tsx`), custom styling tokens and faceted corner designs (`FlightMap.css`), and embedded Natural Earth geometry (`worldMapData.ts`).

While the visual direction is distinct, the branch suffers from severe performance degradation during map interactions (panning, zooming, aircraft selection), noticeable initial load latency, and accessibility regressions.

---

## 1. Root Cause Analysis

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             PERFORMANCE BOTTLENECK CHAIN                         │
└──────────────────────────────────────────────────────────────────────────────────┘
  [worldMapData.ts] ──> 226KB static geometry shipped in main bundle to all users
         │
         ▼
  [VectorBasemap.tsx] ──> 3x3 viewport canvas @ 2x DPR allocates ~300MB texture on GPU
         │
         ├─► Resizes canvas.width/height on every moveend/zoomend (texture destruction)
         ├─► 3 unbatched loops re-running coordinate transformations per vertex
         ├─► ctx.shadowBlur=4 on complex country polygon (Sweden) triggers software blur
         └─► Leaflet fires BOTH zoomend & moveend on zoom (duplicate unthrottled redraws)
         │
         ▼
  [FlightMap.tsx] ──► Blank 1x1 TileLayer hack still runs tile math in the background
```

### 1.1 Massive Canvas GPU Memory Churn (`VectorBasemap.tsx`)
* **3×3 Viewport Size**: `BASEMAP_PADDING_VIEWPORTS = 1` creates a canvas that is 3 times the viewport width and 3 times the viewport height (`canvasW = size.x * 3`, `canvasH = size.y * 3`).
* **Massive Texture Allocations**: On standard Retina / HiDPI screens (`devicePixelRatio = 2`), a 1920×1080 screen generates a canvas of **11,520 × 6,480 pixels** (~74.6 million pixels = **~300 MB of uncompressed bitmap memory**).
* **Destruction & Re-allocation per Gesture**: Setting `canvas.width` and `canvas.height` inside `redraw()` on every `moveend`/`zoomend` forces the browser engine and GPU to discard the old surface and allocate a new multi-hundred-megabyte texture, triggering severe main-thread pauses (100–300ms) and garbage collection stalls.

### 1.2 Unbatched Multi-Pass Rendering (`VectorBasemap.tsx`)
* **3 Repetitive Coordinate Projection Passes**: `visible.forEach` iterates 3 separate times (for fill gradient, land outline, and borders), calling `drawCountryRings(c)` which re-computes `projectFast(wp)` for every single vertex in every ring on all 3 passes.
* **Unbatched Canvas Draw Calls**: Calling `ctx.beginPath()`, `ctx.fill()`, and `ctx.stroke()` per country prevents 2D canvas batching in browser graphics backends.
* **Software Gaussian Blur**: The Sweden highlight uses `ctx.shadowBlur = 4`. Canvas shadows on complex multi-vertex polygons force an unaccelerated software rasterization pass on CPU.

### 1.3 Duplicate Redraws on Map Zoom (`VectorBasemap.tsx`)
* `useMapEvents({ moveend: redraw, zoomend: redraw, resize: redraw })`: Leaflet fires **both** `zoomend` and `moveend` on zoom gestures. Because `redraw` is not debounced or scheduled via `requestAnimationFrame`, every zoom operation triggers two consecutive, heavy canvas redraw passes back-to-back.

### 1.4 Bundle Size Bloat & Main-Thread Startup Blocking (`worldMapData.ts`)
* `worldMapData.ts` contains 226 KB of raw static coordinate arrays embedded directly in the JavaScript bundle.
* Because `VectorBasemap.tsx` is statically imported by `FlightMap.tsx`, the main chunk size exceeds 575 kB. Default-theme users pay the network download, parse, and execution penalty on every page load for a theme they may never activate.

### 1.5 TileLayer Hack & Phantom DOM Tile Overheads (`FlightMap.tsx`)
* Pointing `TileLayer` to a 1×1 transparent PNG data URI (`BLANK_TILE_URL`) keeps Leaflet's tile engine active (calculating tile coordinates, inserting empty DOM tile nodes, and managing events in `tilePane` behind the canvas).
* When toggling themes back and forth, changing `TileLayer.url` flushes Leaflet's tile cache and forces a full re-fetch of OpenStreetMap tiles over the network.

### 1.6 Accessibility & Test Suite Regression (`FlightMap.tsx`)
* `planeIcon` sets `role="img"` with `aria-label="Aircraft position marker"`. Because Leaflet gives the outer marker container `role="button"`, accessible queries matching `"Aircraft"` match all 20+ aircraft icons on the map, colliding with the `"☆ Aircraft"` favorite toggle button and failing `tests/favorites.spec.ts`.

---

## 2. Step-by-Step Fix & Implementation Plan

### Step 1: Optimize Canvas Surface & Memory Lifecycle
1. **Remove Excessive Padding & Clamp DPR**:
   * Size the canvas to the exact container viewport (`size.x`, `size.y`), or a minimal margin (e.g. 0.1), and clamp DPR to a maximum of 2 (`Math.min(window.devicePixelRatio || 1, 2)`).
2. **Reuse the Canvas Backing Store**:
   * Only reallocate `canvas.width` and `canvas.height` when the window or map container actually resizes (`resize` event).
   * On pan/zoom redraws, keep the existing canvas size and clear with `ctx.clearRect(0, 0, canvasW, canvasH)`.

### Step 2: Batch Vector Drawing & Eliminate Software Blur
1. **Single-Pass Path Batching**:
   * Pre-calculate transformed points for visible polygons once per frame.
   * Combine all visible country polygons into a single path and execute **one single `ctx.fill()`** and **one single `ctx.stroke()`**.
2. **Replace `shadowBlur` with Layered Strokes**:
   * Replace `ctx.shadowBlur = 4` with a double-stroke technique (a wide semi-transparent stroke `rgba(255, 182, 60, 0.25)` at 4px width, followed by the solid `#ffb63c` line at 1.8px width). This renders instantly without triggering software blur.

### Step 3: RAF-Debounce Map Event Redraws
Wrap the redraw function in a `requestAnimationFrame` loop to deduplicate simultaneous `zoomend` and `moveend` events:

```ts
const rafRef = useRef<number | null>(null);

const scheduleRedraw = useCallback(() => {
  if (rafRef.current != null) return;
  rafRef.current = requestAnimationFrame(() => {
    rafRef.current = null;
    redraw();
  });
}, [redraw]);

useMapEvents({
  moveend: scheduleRedraw,
  zoomend: scheduleRedraw,
  resize: () => {
    updateCanvasDimensions();
    scheduleRedraw();
  },
});
```

### Step 4: Code Splitting & Dynamic Import
Lazy-load `VectorBasemap` so `worldMapData.ts` (226 KB) is isolated into an on-demand async chunk:

```tsx
// FlightMap.tsx
import { lazy, Suspense } from "react";

const VectorBasemap = lazy(() => import("./VectorBasemap"));

// Inside MapContainer:
{theme === "cyberpunk" && (
  <Suspense fallback={null}>
    <VectorBasemap />
  </Suspense>
)}
```

### Step 5: Clean Layer Management
Conditionally mount the real `<TileLayer>` only when `theme === "default"`, removing the transparent 1×1 PNG placeholder workaround:

```tsx
{theme === "default" ? (
  <TileLayer
    attribution='&copy; OpenStreetMap contributors'
    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
  />
) : (
  <Suspense fallback={null}>
    <VectorBasemap />
  </Suspense>
)}
```

### Step 6: Font Loading & Mobile CSS Polish
1. **Add Font Preconnect Headers** in `index.html`:
   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com" />
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
   ```
2. **Prevent Mobile Scroll Jank**:
   Avoid setting `clip-path` directly on elements with `overflow-y: auto`. Apply `clip-path` to non-scrolling container wrappers instead.

### Step 7: Fix Accessible Button Collision
In `FlightMap.tsx`, update the plane icon markup or test selector so that marker icons do not hijack generic accessible button queries matching `"Aircraft"`:

```tsx
// In planeIcon:
html: `<div class="plane-icon-halo" aria-hidden="true"></div><div class="${glyphClass}" aria-hidden="true">${PLANE_SVG}</div>`
```

---

## 3. Expected Performance Gains

| Metric | Current Branch | After Recommended Fixes |
| :--- | :--- | :--- |
| **Canvas Memory Footprint** | ~300 MB (Retina 1080p) | ~16 MB (Viewport-fitted) |
| **Main Bundle Size (`dist/assets/index-*.js`)** | >575 kB | ~340 kB (-40% reduction) |
| **Redraw Draw Calls per Frame** | ~500+ individual calls | 2–4 batched calls |
| **Zoom Redraw Frequency** | 2 unthrottled redraws | 1 RAF-scheduled redraw |
| **Pan/Zoom Frame Budget** | 100–300ms jank spikes | Smooth 60fps (under 16ms) |
| **E2E Playwright Suite** | 1 failed test (`favorites.spec.ts`) | 100% passing suite |
