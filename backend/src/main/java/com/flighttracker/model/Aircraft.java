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

    @Column(name = "destination_airport")
    private String destinationAirport;

    @Column(name = "metadata_fetched_at")
    private Instant metadataFetchedAt;

    @Column(name = "first_seen_at", nullable = false)
    private Instant firstSeenAt = Instant.now();

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
    public String getDestinationAirport() { return destinationAirport; }
    public void setDestinationAirport(String destinationAirport) { this.destinationAirport = destinationAirport; }
    public Instant getMetadataFetchedAt() { return metadataFetchedAt; }
    public void setMetadataFetchedAt(Instant metadataFetchedAt) { this.metadataFetchedAt = metadataFetchedAt; }
    public Instant getFirstSeenAt() { return firstSeenAt; }
    public Instant getLastSeenAt() { return lastSeenAt; }
    public void touch() { this.lastSeenAt = Instant.now(); }
}
