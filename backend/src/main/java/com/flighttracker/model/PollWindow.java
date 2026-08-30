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

    // See PollWindowService.restart() for the actual quota logic — this
    // just persists its state. Null quotaWindowStart means no quota
    // window has started yet (or the last one has fully expired and been
    // superseded), equivalent to quotaRestartCount being 0.
    @Column(name = "quota_window_start")
    private Instant quotaWindowStart;

    @Column(name = "quota_restart_count", nullable = false)
    private int quotaRestartCount = 0;

    protected PollWindow() { }

    public PollWindow(Instant activeUntil) {
        this.activeUntil = activeUntil;
    }

    public Integer getId() { return id; }
    public Instant getActiveUntil() { return activeUntil; }
    public void setActiveUntil(Instant activeUntil) { this.activeUntil = activeUntil; }
    public Instant getQuotaWindowStart() { return quotaWindowStart; }
    public void setQuotaWindowStart(Instant quotaWindowStart) { this.quotaWindowStart = quotaWindowStart; }
    public int getQuotaRestartCount() { return quotaRestartCount; }
    public void setQuotaRestartCount(int quotaRestartCount) { this.quotaRestartCount = quotaRestartCount; }
}
