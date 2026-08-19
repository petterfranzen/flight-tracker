import { test } from "node:test";
import assert from "node:assert/strict";
import { WS_URL } from "./support/config.js";
import { assertFlightPositionShape } from "./support/assertions.js";

// How long we're willing to wait for a single push frame before giving up
// on the "did we get real data" check. Positions only flow when the agent
// orchestrator's poll cycle actually finds new aircraft in its bounding
// box, so absence of a frame in this window says nothing about whether the
// endpoint itself is healthy — only the connection open/close behavior
// below is treated as a hard pass/fail.
const FRAME_WAIT_MS = 20_000;

test("GET /ws/live upgrades and accepts a connection", { timeout: FRAME_WAIT_MS + 5_000 }, async (t) => {
  const socket = new WebSocket(WS_URL);

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", (e) => reject(new Error(`WebSocket error: ${e.message ?? e}`)), { once: true });
  });
  assert.equal(socket.readyState, WebSocket.OPEN);

  try {
    const firstFrame = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), FRAME_WAIT_MS);
      socket.addEventListener(
        "message",
        (event) => {
          clearTimeout(timer);
          resolve(event.data);
        },
        { once: true }
      );
    });

    if (firstFrame === null) {
      t.diagnostic(
        `no frame received within ${FRAME_WAIT_MS}ms — inconclusive, not a failure ` +
          "(depends on live traffic in the configured bounding box and the agent poll cadence)"
      );
    } else {
      const parsed = JSON.parse(firstFrame);
      assertFlightPositionShape(parsed);
    }
  } finally {
    // Must run even if the shape assertion above throws, or the socket
    // stays open and node:test hangs waiting for the event loop to drain.
    await new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
      socket.close();
    });
  }
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("GET /ws/live does not serve a plain HTTP GET (no upgrade) as a normal 200 response", async () => {
  const httpUrl = WS_URL.replace(/^ws/, "http");
  // Spring's raw WebSocketHandler doesn't reply at all to a non-upgrade
  // request rather than answering with an error status — it just leaves the
  // connection open, so this needs its own hard deadline or it hangs forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(httpUrl, { signal: controller.signal });
    assert.notEqual(res.status, 200);
  } catch (err) {
    assert.equal(err.name, "AbortError", `expected a timeout/abort, got: ${err}`);
  } finally {
    clearTimeout(timer);
  }
});
