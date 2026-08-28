package com.flighttracker.service;

import com.flighttracker.dto.Bounds;
import com.flighttracker.model.ViewportState;
import com.flighttracker.repository.ViewportStateRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Shared "which lat/lon box is currently on someone's screen" state — see
 * the viewport_state table comment in schema.sql for why this is DB-backed
 * (the "agent" container's OpenSkyAgent, which needs this to know what to
 * hot-poll, is a separate process from the "api" container, which is where
 * the frontend's viewport reports land).
 *
 * Same single-shared-row model as PollWindowService: one map, one viewer
 * at a time, not a per-session/per-connection viewport.
 */
@Service
public class ViewportService {

    private static final Integer ROW_ID = 1;
    private static final Bounds DEFAULT = new Bounds(54.0, 66.0, 10.0, 25.0);

    private final ViewportStateRepository repository;

    // Same-process fast path for LiveFeedBroadcaster, which would otherwise
    // need a DB round trip on every single position it considers
    // broadcasting. Only ever populated by report() in *this* process — the
    // "agent" container never calls report(), so it always reads through
    // current() instead.
    private volatile Bounds cached;

    public ViewportService(ViewportStateRepository repository) {
        this.repository = repository;
    }

    @Transactional
    public void report(Bounds bounds) {
        ViewportState state = repository.findById(ROW_ID)
                .orElseGet(() -> new ViewportState(bounds.latMin(), bounds.latMax(), bounds.lonMin(), bounds.lonMax()));
        state.update(bounds.latMin(), bounds.latMax(), bounds.lonMin(), bounds.lonMax());
        repository.save(state);
        cached = bounds;
    }

    /** Always reads through to the DB — the only correct source in a different process than whichever last called report(). */
    public Bounds current() {
        return repository.findById(ROW_ID)
                .map(s -> new Bounds(s.getLatMin(), s.getLatMax(), s.getLonMin(), s.getLonMax()))
                .orElse(DEFAULT);
    }

    /** Fast same-process read for LiveFeedBroadcaster; falls back to a DB read once, before this process has seen its first report(). */
    public Bounds currentCached() {
        Bounds c = cached;
        return c != null ? c : current();
    }
}
