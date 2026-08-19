import assert from "node:assert/strict";

// Shape-checks a single FlightPosition as returned by /api/flights/*.
// Deliberately loose on nullable numeric fields (altitude/velocity/heading
// /vertical rate are all nullable at the source — OpenSky doesn't always
// have a fix on every field).
export function assertFlightPositionShape(pos) {
  assert.equal(typeof pos.icao24, "string");
  assert.ok(pos.icao24.length > 0, "icao24 must not be empty");
  assert.equal(typeof pos.observedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(pos.observedAt)), "observedAt must be a parseable timestamp");
  assert.equal(typeof pos.latitude, "number");
  assert.equal(typeof pos.longitude, "number");
  assert.ok(pos.latitude >= -90 && pos.latitude <= 90, "latitude out of range");
  assert.ok(pos.longitude >= -180 && pos.longitude <= 180, "longitude out of range");
  assert.equal(typeof pos.onGround, "boolean");
  assert.equal(typeof pos.agentSource, "string");
  for (const field of ["altitudeM", "velocityMs", "headingDeg", "verticalRateMs"]) {
    assert.ok(
      pos[field] === null || typeof pos[field] === "number",
      `${field} must be null or a number, got ${typeof pos[field]}`
    );
  }
}

export function assertAircraftUsageShape(usage) {
  assert.equal(typeof usage.icao24, "string");
  assert.ok(usage.icao24.length > 0, "icao24 must not be empty");
  assert.ok(
    usage.registration === null || typeof usage.registration === "string",
    "registration must be null or a string"
  );
  assert.equal(typeof usage.positionReports, "number");
  assert.equal(typeof usage.distanceFlownKm, "number");
  assert.equal(typeof usage.airborneHours, "number");
  assert.equal(typeof usage.averageGroundSpeedKmh, "number");
  assert.ok(usage.positionReports >= 0);
  assert.ok(usage.distanceFlownKm >= 0, "distance flown cannot be negative");
  assert.ok(usage.airborneHours >= 0, "airborne hours cannot be negative");
  assert.ok(usage.averageGroundSpeedKmh >= 0, "average ground speed cannot be negative");
}
