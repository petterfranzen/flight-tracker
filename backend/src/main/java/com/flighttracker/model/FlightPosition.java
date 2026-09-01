package com.flighttracker.model;

import jakarta.persistence.*;
import java.time.Instant;

/**
 * One historic position report. Rows are never updated — the usage service
 * derives distance/airtime by walking consecutive rows for an aircraft.
 */
@Entity
@Table(name = "flight_position")
public class FlightPosition {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "icao24", nullable = false, length = 6)
    private String icao24;

    private String callsign;

    @Column(name = "observed_at", nullable = false)
    private Instant observedAt;

    private double latitude;
    private double longitude;

    @Column(name = "altitude_m")
    private Double altitudeM;

    @Column(name = "velocity_ms")
    private Double velocityMs;

    @Column(name = "heading_deg")
    private Double headingDeg;

    @Column(name = "vertical_rate_ms")
    private Double verticalRateMs;

    @Column(name = "on_ground", nullable = false)
    private boolean onGround;

    @Column(name = "agent_source", nullable = false, length = 32)
    private String agentSource;

    protected FlightPosition() { }

    public FlightPosition(String icao24, String callsign, Instant observedAt,
                           double latitude, double longitude, Double altitudeM,
                           Double velocityMs, Double headingDeg, Double verticalRateMs,
                           boolean onGround, String agentSource) {
        this.icao24 = icao24;
        this.callsign = callsign;
        this.observedAt = observedAt;
        this.latitude = latitude;
        this.longitude = longitude;
        this.altitudeM = altitudeM;
        this.velocityMs = velocityMs;
        this.headingDeg = headingDeg;
        this.verticalRateMs = verticalRateMs;
        this.onGround = onGround;
        this.agentSource = agentSource;
    }

    public Long getId() { return id; }
    public String getIcao24() { return icao24; }
    public String getCallsign() { return callsign; }
    public Instant getObservedAt() { return observedAt; }
    public double getLatitude() { return latitude; }
    public double getLongitude() { return longitude; }
    public Double getAltitudeM() { return altitudeM; }
    public Double getVelocityMs() { return velocityMs; }
    public Double getHeadingDeg() { return headingDeg; }
    public Double getVerticalRateMs() { return verticalRateMs; }
    public boolean isOnGround() { return onGround; }
    public String getAgentSource() { return agentSource; }

    /**
     * A copy of this position with latitude/longitude replaced — used by
     * EstimatedPositionService to dead-reckon a stale report forward
     * without ever mutating the original. Every other field, including
     * observedAt, carries over unchanged: the copy is indistinguishable in
     * shape from a real report, deliberately — see EstimatorAgent's
     * javadoc for why the frontend is never told which is which. This
     * in-memory copy itself is never persisted as a row — EstimatorAgent
     * only takes its latitude/longitude back out to write into
     * aircraft_latest_position's separate estimated_latitude/
     * estimated_longitude columns, never into this entity's own table.
     */
    public FlightPosition withEstimatedPosition(double latitude, double longitude) {
        FlightPosition copy = new FlightPosition(icao24, callsign, observedAt, latitude, longitude,
                altitudeM, velocityMs, headingDeg, verticalRateMs, onGround, agentSource);
        copy.id = this.id;
        return copy;
    }
}
