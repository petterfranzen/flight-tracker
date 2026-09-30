package com.flighttracker.service;

import com.flighttracker.dto.Bounds;
import org.springframework.stereotype.Service;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Shared "which lat/lon box is currently on someone's screen" state.
 *
 * Cloud migration A1 (PLAN.md §6 item 6): this used to be backed by the
 * viewport_state table because OpenSkyAgent's hot poll (needing to know
 * what to poll) ran in a separate "agent" container from FlightController
 * (where the frontend's viewport reports land). Now that both live in the
 * same process, a plain AtomicReference does the job — no restart-survival
 * requirement here (a fresh process falling back to DEFAULT until the next
 * report is exactly the original single-process behaviour, before the
 * multi-container split ever added a database in the middle). report()
 * used to be @Async specifically to get a slow DB commit off the request
 * thread (see the old javadoc: a real NAS I/O contention case, 20+ second
 * commits under heavy sweep load); an AtomicReference.set() has no I/O to
 * wait on, so that whole concern — and the dedicated executor
 * (ViewportAsyncConfig) it needed — is gone too.
 *
 * Same single-shared-value model as before: one map, one viewer at a time,
 * not a per-session/per-connection viewport.
 */
@Service
public class ViewportService {

    private static final Bounds DEFAULT = new Bounds(54.0, 66.0, 10.0, 25.0);

    private final AtomicReference<Bounds> current = new AtomicReference<>(DEFAULT);

    /** Called from FlightController whenever a client reports its current map viewport (GET /api/flights/live with bbox params). */
    public void report(Bounds bounds) {
        current.set(bounds);
    }

    public Bounds current() {
        return current.get();
    }

    /**
     * Same as current() now that both live in the same process and neither
     * involves a DB round trip — kept as a separate method rather than
     * folding LiveFeedBroadcaster's call sites into current() directly, so
     * that distinction ("this read is on the hot broadcast path") stays
     * visible at the call site even though the two are identical today.
     */
    public Bounds currentCached() {
        return current.get();
    }
}
