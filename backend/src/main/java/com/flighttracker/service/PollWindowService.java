package com.flighttracker.service;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.model.PollWindow;
import com.flighttracker.repository.PollWindowRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;

/**
 * Shared bounded-polling state — see the poll_window table comment in
 * schema.sql for why this is DB-backed rather than an in-memory
 * AtomicReference: AgentOrchestrator (the "agent" container, which decides
 * whether to actually poll) and AgentController (the "api" container,
 * which exposes GET/POST /api/agents/{status,restart} to the UI) are now
 * separate processes.
 */
@Service
public class PollWindowService {

    private static final Integer ROW_ID = 1;

    private final PollWindowRepository repository;
    private final Duration pollWindow;

    public PollWindowService(PollWindowRepository repository,
                              @Value("${flighttracker.agents.poll-window-seconds}") long pollWindowSeconds) {
        this.repository = repository;
        this.pollWindow = Duration.ofSeconds(pollWindowSeconds);
    }

    /** Reopens the window for another {@code pollWindow} from now. */
    @Transactional
    public void restart() {
        PollWindow window = repository.findById(ROW_ID).orElseGet(() -> new PollWindow(Instant.now()));
        window.setActiveUntil(Instant.now().plus(pollWindow));
        repository.save(window);
    }

    public boolean isActive() {
        return repository.findById(ROW_ID)
                .map(w -> Instant.now().isBefore(w.getActiveUntil()))
                .orElse(false);
    }

    public PollingStatus status() {
        Instant until = repository.findById(ROW_ID).map(PollWindow::getActiveUntil).orElse(Instant.EPOCH);
        Instant now = Instant.now();
        boolean active = now.isBefore(until);
        long secondsRemaining = active ? Duration.between(now, until).toSeconds() : 0;
        return new PollingStatus(active, secondsRemaining);
    }
}
