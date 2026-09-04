package com.flighttracker.model;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "aircraft")
public class Aircraft {

    @Id
    @Column(length = 6)
    private String icao24;

    private String registration;
    private String model;
    private String operator;

    @Column(name = "origin_airport")
    private String originAirport;

    @Column(name = "origin_airport_name")
    private String originAirportName;

    @Column(name = "destination_airport")
    private String destinationAirport;

    @Column(name = "destination_airport_name")
    private String destinationAirportName;

    @Column(name = "origin_airport_lat")
    private Double originAirportLat;

    @Column(name = "origin_airport_lon")
    private Double originAirportLon;

    @Column(name = "destination_airport_lat")
    private Double destinationAirportLat;

    @Column(name = "destination_airport_lon")
    private Double destinationAirportLon;

    @Column(name = "metadata_fetched_at")
    private Instant metadataFetchedAt;

    // See AircraftEnrichmentService.checkLandingIfNeeded and
    // OpenSkyFlightsClient.confirmLanded — landingCheckObservedAt is which
    // position report this was last checked against (throttles re-checking
    // and self-invalidates once a new leg's reports arrive); landingConfirmedAt
    // is OpenSky's own reported arrival time, null unless confirmed.
    @Column(name = "landing_check_observed_at")
    private Instant landingCheckObservedAt;

    @Column(name = "landing_confirmed_at")
    private Instant landingConfirmedAt;

    @Column(name = "first_seen_at", nullable = false)
    private Instant firstSeenAt = Instant.now();

    // No longer maintained after the row is created — the per-sweep bump
    // was ~2.76M updates/day against a column nothing reads, so it was
    // removed from both write paths (see PositionPersistenceService's
    // AIRCRAFT_UPSERT_SQL). Effectively "first report seen" now. Kept
    // rather than dropped only because it's NOT NULL and costs nothing to
    // leave in place; if a real "last seen" is ever wanted, note that
    // aircraft_latest_position.observed_at already is exactly that, kept
    // current for free.
    @Column(name = "last_seen_at", nullable = false)
    private Instant lastSeenAt = Instant.now();

    protected Aircraft() { }

    public Aircraft(String icao24) {
        this.icao24 = icao24;
    }

    public String getIcao24() { return icao24; }
    public String getRegistration() { return registration; }
    public void setRegistration(String registration) { this.registration = registration; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public String getOperator() { return operator; }
    public void setOperator(String operator) { this.operator = operator; }
    public String getOriginAirport() { return originAirport; }
    public void setOriginAirport(String originAirport) { this.originAirport = originAirport; }
    public String getOriginAirportName() { return originAirportName; }
    public void setOriginAirportName(String originAirportName) { this.originAirportName = originAirportName; }
    public String getDestinationAirport() { return destinationAirport; }
    public void setDestinationAirport(String destinationAirport) { this.destinationAirport = destinationAirport; }
    public String getDestinationAirportName() { return destinationAirportName; }
    public void setDestinationAirportName(String destinationAirportName) { this.destinationAirportName = destinationAirportName; }
    public Double getOriginAirportLat() { return originAirportLat; }
    public void setOriginAirportLat(Double originAirportLat) { this.originAirportLat = originAirportLat; }
    public Double getOriginAirportLon() { return originAirportLon; }
    public void setOriginAirportLon(Double originAirportLon) { this.originAirportLon = originAirportLon; }
    public Double getDestinationAirportLat() { return destinationAirportLat; }
    public void setDestinationAirportLat(Double destinationAirportLat) { this.destinationAirportLat = destinationAirportLat; }
    public Double getDestinationAirportLon() { return destinationAirportLon; }
    public void setDestinationAirportLon(Double destinationAirportLon) { this.destinationAirportLon = destinationAirportLon; }
    public Instant getMetadataFetchedAt() { return metadataFetchedAt; }
    public void setMetadataFetchedAt(Instant metadataFetchedAt) { this.metadataFetchedAt = metadataFetchedAt; }
    public Instant getLandingCheckObservedAt() { return landingCheckObservedAt; }
    public void setLandingCheckObservedAt(Instant landingCheckObservedAt) { this.landingCheckObservedAt = landingCheckObservedAt; }
    public Instant getLandingConfirmedAt() { return landingConfirmedAt; }
    public void setLandingConfirmedAt(Instant landingConfirmedAt) { this.landingConfirmedAt = landingConfirmedAt; }
    public Instant getFirstSeenAt() { return firstSeenAt; }
    public Instant getLastSeenAt() { return lastSeenAt; }
}
