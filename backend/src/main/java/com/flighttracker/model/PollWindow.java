package com.flighttracker.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/** Single row (id=1) — see PollWindowService for why this exists as a table, not memory. */
@Entity
@Table(name = "poll_window")
public class PollWindow {

    @Id
    private Integer id = 1;

    @Column(name = "active_until", nullable = false)
    private Instant activeUntil;

    protected PollWindow() { }

    public PollWindow(Instant activeUntil) {
        this.activeUntil = activeUntil;
    }

    public Integer getId() { return id; }
    public Instant getActiveUntil() { return activeUntil; }
    public void setActiveUntil(Instant activeUntil) { this.activeUntil = activeUntil; }
}
