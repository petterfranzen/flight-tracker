package com.flighttracker.dto;

import java.time.Instant;

/**
 * GET /api/health's body — cloud migration A1, PLAN.md §6 item 11.
 * version is the 40-char git SHA CI passes to the build
 * (-Dgit.sha=$GITHUB_SHA, read back out via Spring Boot's BuildProperties);
 * deploy.sh polls this endpoint and waits for exactly that value before
 * considering a deploy healthy, so it must be the full SHA, not a short
 * one. "dev" when no build-info was generated (a local/backend-only build
 * with no -Dgit.sha, e.g. this repo's own `mvn verify`).
 */
public record HealthStatus(String status, String version, String db, Instant lastSweepAt) {
}
