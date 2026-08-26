package com.flighttracker.dto;

public record PollingStatus(boolean active, long secondsRemaining) { }
