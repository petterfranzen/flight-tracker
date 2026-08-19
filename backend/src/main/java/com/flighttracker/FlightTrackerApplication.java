package com.flighttracker;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling // the agents are scheduled pollers, see service/agent
public class FlightTrackerApplication {
    public static void main(String[] args) {
        SpringApplication.run(FlightTrackerApplication.class, args);
    }
}
