package com.flighttracker.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/** Single row (id=1) — see ViewportService for why this exists as a table, not memory. */
@Entity
@Table(name = "viewport_state")
public class ViewportState {

    @Id
    private Integer id = 1;

    @Column(name = "lat_min", nullable = false)
    private double latMin;

    @Column(name = "lat_max", nullable = false)
    private double latMax;

    @Column(name = "lon_min", nullable = false)
    private double lonMin;

    @Column(name = "lon_max", nullable = false)
    private double lonMax;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    protected ViewportState() { }

    public ViewportState(double latMin, double latMax, double lonMin, double lonMax) {
        this.latMin = latMin;
        this.latMax = latMax;
        this.lonMin = lonMin;
        this.lonMax = lonMax;
    }

    public Integer getId() { return id; }
    public double getLatMin() { return latMin; }
    public double getLatMax() { return latMax; }
    public double getLonMin() { return lonMin; }
    public double getLonMax() { return lonMax; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void update(double latMin, double latMax, double lonMin, double lonMax) {
        this.latMin = latMin;
        this.latMax = latMax;
        this.lonMin = lonMin;
        this.lonMax = lonMax;
        this.updatedAt = Instant.now();
    }
}
