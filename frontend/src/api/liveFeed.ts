import type { FlightPosition } from "../types/flight";

// Capped exponential backoff for WS reconnects: first retry after 1s,
// doubling on every further consecutive failure, capped at 30s, with ±25%
// jitter so a server restart doesn't get every open tab reconnecting in
// lock-step.
const WS_RECONNECT_MIN_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;
// Backoff only resets once a connection has *stayed* up this long. It used
// to reset in onopen, so a socket the server accepted (101) and then
// dropped — e.g. closing it 1011 after its send buffer to us overflowed —
// reconnected every 1s forever instead of backing off.
const WS_STABLE_AFTER_MS = 15_000;
// Close codes where retrying the same request can never succeed (1002
// protocol error, 1003 unsupported data, 1008 policy violation) — stop
// instead of hammering the server; a reload starts over.
const WS_FATAL_CLOSE_CODES = new Set([1002, 1003, 1008]);

function isFlightPosition(data: unknown): data is FlightPosition {
  if (!data || typeof data !== "object") return false;
  const p = data as Record<string, unknown>;
  return typeof p.icao24 === "string" && typeof p.observedAt === "string";
}

/** Same-origin /ws/live, ws:// or wss:// to match the page (Cloudflare serves https, so wss). */
export function liveFeedUrl(loc: Pick<Location, "href" | "protocol"> = location): string {
  const url = new URL("/ws/live", loc.href);
  url.protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Subscribes to the live push feed; returns an unsubscribe function.
 *
 * Keepalive: the backend sends native WS ping frames every 30s, which the
 * browser answers itself — they never reach `onmessage`. A `{"type":"ping"}`
 * text frame (the fallback PLAN.md §6 item 9 mentions) is also tolerated:
 * it isn't a FlightPosition, so it's dropped like any other non-position
 * frame.
 *
 * Reconnects on any unexpected close with capped, jittered exponential
 * backoff (see the constants above). Never touches /api/agents/restart:
 * reopening the poll window is a page-load / Resume-button decision only.
 */
export interface LiveFeedOptions {
  /**
   * Called when the feed reconnects after a drop (not the first connect), so a
   * caller can drop the state it held between the two connections.
   */
  onReconnect?: () => void;
}

export function subscribeLiveFeed(onPosition: (p: FlightPosition) => void, options: LiveFeedOptions = {}): () => void {
  const feed = new LiveFeed(onPosition, options);
  const onOnline = () => feed.onOnline();
  window.addEventListener("online", onOnline);
  feed.connect();
  return () => {
    window.removeEventListener("online", onOnline);
    feed.stop();
  };
}

/** One subscription's socket, timers and backoff (see subscribeLiveFeed). */
class LiveFeed {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = WS_RECONNECT_MIN_MS;
  private stopped = false;
  private connected = false;

  constructor(
    private readonly onPosition: (p: FlightPosition) => void,
    private readonly options: LiveFeedOptions,
  ) {}

  connect(): void {
    this.reconnectTimer = null;
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(liveFeedUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    // Every handler below checks `ws === socket`: events from a socket that
    // has already been replaced must never touch the current one (the old
    // onerror called `socket?.close()` on the shared variable, which could
    // close the *new* connection).
    ws.onopen = () => {
      if (ws === this.socket) this.opened();
    };
    ws.onmessage = (event) => {
      if (ws === this.socket) this.message(event);
    };
    // onerror is always followed by onclose; reconnect is handled there, once.
    ws.onerror = () => {};
    ws.onclose = (event) => {
      if (ws === this.socket) this.closed(event);
    };
  }

  private opened(): void {
    if (this.connected) this.options.onReconnect?.();
    this.connected = true;
    this.stableTimer = setTimeout(() => {
      this.backoffMs = WS_RECONNECT_MIN_MS;
    }, WS_STABLE_AFTER_MS);
  }

  private message(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return; // ignore malformed frame
    }
    if (isFlightPosition(data)) this.onPosition(data);
  }

  private closed(event: CloseEvent): void {
    this.socket = null;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    if (this.stopped) return;
    if (WS_FATAL_CLOSE_CODES.has(event.code)) {
      console.warn(`live feed closed with ${event.code} (${event.reason || "no reason"}) — not reconnecting`);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.round(this.backoffMs * (0.75 + Math.random() * 0.5));
    this.backoffMs = Math.min(WS_RECONNECT_MAX_MS, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // Back online after a network drop: don't sit out the rest of a 30s backoff.
  onOnline(): void {
    if (this.stopped || this.socket) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.backoffMs = WS_RECONNECT_MIN_MS;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.socket?.close(1000);
    this.socket = null;
  }
}
