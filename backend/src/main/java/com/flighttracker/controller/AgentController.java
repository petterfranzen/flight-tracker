package com.flighttracker.controller;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.service.agent.AgentOrchestrator;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/agents")
public class AgentController {

    private final AgentOrchestrator orchestrator;

    public AgentController(AgentOrchestrator orchestrator) {
        this.orchestrator = orchestrator;
    }

    /** Whether the poll window is currently open, and how long until it closes — for a UI countdown. */
    @GetMapping("/status")
    public PollingStatus status() {
        return orchestrator.status();
    }

    /** Reopens the poll window (see AgentOrchestrator's poll-window comment) — wired to the frontend's restart button. */
    @PostMapping("/restart")
    public PollingStatus restart() {
        orchestrator.restartPolling();
        return orchestrator.status();
    }
}
