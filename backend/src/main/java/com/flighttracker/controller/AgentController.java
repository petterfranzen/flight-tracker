package com.flighttracker.controller;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.service.PollWindowService;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/agents")
@Profile("api")
public class AgentController {

    private final PollWindowService pollWindowService;

    public AgentController(PollWindowService pollWindowService) {
        this.pollWindowService = pollWindowService;
    }

    /** Whether the poll window is currently open, and how long until it closes — for a UI countdown. */
    @GetMapping("/status")
    public PollingStatus status() {
        return pollWindowService.status();
    }

    /** Reopens the poll window (see PollWindowService) — wired to the frontend's restart button. */
    @PostMapping("/restart")
    public PollingStatus restart() {
        pollWindowService.restart();
        return pollWindowService.status();
    }

    /** Closes the poll window immediately — wired to the frontend's stop button. */
    @PostMapping("/stop")
    public PollingStatus stop() {
        pollWindowService.stop();
        return pollWindowService.status();
    }
}
