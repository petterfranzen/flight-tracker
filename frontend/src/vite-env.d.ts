/// <reference types="vite/client" />

// Pulls in Vite's own declarations for its import suffixes — notably the
// `?worker&url` form MaplibreBasemap.tsx needs. Without this, TypeScript
// sees those as untyped module specifiers.
