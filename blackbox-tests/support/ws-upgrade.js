// Raw WebSocket upgrade so the request can carry an Origin header. Node's
// global WebSocket client cannot set request headers, and /ws/live's allow-list
// is keyed on Origin (backend/src/main/java/com/flighttracker/config/WebSocketConfig.java)
// — so the only way to test it from Node is the handshake itself.
//
// Twin of the helper embedded in scripts/smoke-prod.sh: the smoke script has to
// stay a single portable file (it is the thing you run on a box after a deploy),
// so it cannot import this. Keep the two in step.

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

/**
 * Open /ws/live (or any path) with an explicit Origin.
 *
 * Resolves with { status, socket, head }: status is 101 and socket is live when
 * the server upgraded, otherwise status is the rejection's HTTP status and
 * socket is null.
 */
export function openSocket(baseUrl, origin, path = "/ws/live") {
  const u = new URL(baseUrl);
  const lib = u.protocol === "https:" ? https : http;
  const key = crypto.randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path,
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
          Origin: origin,
        },
      },
      (res) => {
        // Not an upgrade: Spring's Origin interceptor answers 403 here.
        res.resume();
        resolve({ status: res.statusCode, socket: null, head: null });
      },
    );
    req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode, socket, head }));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Split incoming bytes into WebSocket frames and hand back each text payload.
 * Server frames are unmasked, so nothing needs unmasking here.
 */
export function frameReader(onText) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (opcode === 0x1) onText(payload.toString("utf8"));
    }
  };
}

/**
 * Wait up to timeoutMs for the first text frame. Resolves with the payload
 * string, or null when none arrived (no live traffic to push is a legal state).
 * Destroys the socket either way.
 */
export function firstFrame(conn, timeoutMs) {
  return new Promise((resolve) => {
    if (!conn.socket) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const feed = frameReader((text) => finish(text));
    if (conn.head && conn.head.length) feed(conn.head);
    conn.socket.on("data", feed);
    conn.socket.on("error", () => finish(null));
    conn.socket.on("close", () => finish(null));
  });
}
