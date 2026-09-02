import { useEffect, useRef, useState } from "react";
import "./BootScreen.css";

const STATUS_LINES = [
  "Initializing Gridlink terminal…",
  "Breaching ADS-B uplink…",
  "Authenticating Netwatch credentials…",
  "Syncing live aircraft feed…",
];

// Kept visible at least this long even if the real fetch resolves almost
// instantly — a boot sequence that flashes for 40ms reads as a glitch,
// not as "fast." The whole point of gating this on `ready` (see below)
// rather than a fixed timer is to track how long loading actually
// takes, not fake it — but a literal 0ms transition isn't itself
// informative to look at either.
const MIN_VISIBLE_MS = 900;
const STATUS_LINE_INTERVAL_MS = 620;

/**
 * Cyberpunk theme's boot sequence, shown once per page load. Real
 * loading state gates when it's allowed to dismiss (see FlightMap's
 * firstLoadDone/applyLiveSnapshot.finally), not a fixed timer — the
 * status lines and progress bar are flavor, cycling/filling toward (not
 * to) completion on their own for as long as the real fetch is still in
 * flight, but only reach "Uplink established." and start the hide
 * transition once `ready` actually goes true (or MIN_VISIBLE_MS has
 * passed, whichever is later) — including on a failed fetch, so a
 * backend that's down doesn't strand anyone on "Initializing…" forever.
 */
export default function BootScreen({ ready }: { ready: boolean }) {
  const [lineIndex, setLineIndex] = useState(0);
  const [pct, setPct] = useState(0);
  const [dismissing, setDismissing] = useState(false);
  const [hidden, setHidden] = useState(false);
  const mountedAtRef = useRef(Date.now());
  const reduceMotion = useRef(
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  ).current;

  // Generated once, not on every render — a per-render regeneration would
  // fight the CSS drift animation applied to this text, and there's
  // nothing about it that needs to change after mount anyway.
  const [noise] = useState(() => {
    let hex = "";
    for (let i = 0; i < 900; i++) {
      hex += Math.floor(Math.random() * 16).toString(16) + (i % 44 === 43 ? "\n" : " ");
    }
    return hex;
  });

  // Cycles through the flavor status lines, holding on the last one
  // until dismissal — never needs to know about `ready` itself, just
  // stops advancing once it runs out of lines.
  useEffect(() => {
    if (lineIndex >= STATUS_LINES.length - 1) return;
    const t = setTimeout(() => setLineIndex((i) => i + 1), STATUS_LINE_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [lineIndex]);

  // Fills toward, not all the way to, 100% on its own — real completion
  // below is what actually finishes it. A bar honestly sitting at ~90%
  // through a slow real fetch says more than one that hits 100% on a
  // fixed timer regardless of whether the fetch actually landed yet.
  useEffect(() => {
    if (dismissing) return;
    const tick = reduceMotion ? 260 : 170;
    const id = setInterval(() => {
      setPct((p) => Math.min(92, p + Math.random() * 8 + 3));
    }, tick);
    return () => clearInterval(id);
  }, [dismissing, reduceMotion]);

  useEffect(() => {
    if (!ready || dismissing) return;
    const elapsed = Date.now() - mountedAtRef.current;
    const delay = Math.max(0, MIN_VISIBLE_MS - elapsed);
    const t = setTimeout(() => {
      setDismissing(true);
      setPct(100);
      setTimeout(() => setHidden(true), 450);
    }, delay);
    return () => clearTimeout(t);
  }, [ready, dismissing]);

  if (hidden) return null;

  return (
    <div className={`boot-screen${dismissing ? " boot-screen--hidden" : ""}`} role="status" aria-live="polite">
      <div className="boot-noise" aria-hidden="true">{noise}</div>
      <div className="boot-scanlines" aria-hidden="true"></div>
      <div className="boot-scan-sweep" aria-hidden="true"></div>
      <div className="boot-content">
        <div>
          <span className="boot-logo-glitch" data-text="Netwatch Skygrid">Netwatch Skygrid</span>
          <div className="boot-logo-sub">Gridlink OS // Netwatch Uplink Terminal</div>
        </div>
        <div className="boot-status">{dismissing ? "Uplink established." : STATUS_LINES[lineIndex]}</div>
        <div className="boot-bar-track">
          <div className="boot-bar-fill" style={{ width: `${pct}%` }}></div>
        </div>
        <div className="boot-pct">{Math.floor(pct)}%</div>
      </div>
    </div>
  );
}
