package com.flighttracker;

import com.flighttracker.profile.ProfileProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling // the agents are scheduled pollers, see service/agent
@EnableAsync // AircraftEnrichmentService's third-party lookups run off the poll thread
@EnableConfigurationProperties(ProfileProperties.class) // the optional-social-login flag, flighttracker.profile.enabled
public class FlightTrackerApplication {
    public static void main(String[] args) {
        SpringApplication.run(FlightTrackerApplication.class, args);
    }
}
