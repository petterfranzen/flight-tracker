package com.flighttracker;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling // the agents are scheduled pollers, see service/agent
@EnableAsync // AircraftEnrichmentService's third-party lookups run off the poll thread
public class FlightTrackerApplication {
    public static void main(String[] args) {
        SpringApplication.run(FlightTrackerApplication.class, args);
    }
}
