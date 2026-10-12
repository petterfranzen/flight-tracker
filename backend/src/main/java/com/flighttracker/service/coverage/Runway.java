package com.flighttracker.service.coverage;

/**
 * One landing direction of a runway: a physical runway "01L/19R" is two
 * of these, one per end. {@code thresholdLat/Lon} is where an aircraft
 * landing in this direction crosses the threshold, and {@code headingDeg}
 * is the true heading it lands on. Shared by the runway index (seeded from
 * OurAirports) and the coverage-gap estimator, which only ever sees a
 * list of nearby ones.
 */
public record Runway(String airportIcao,
                     String ident,
                     double thresholdLat,
                     double thresholdLon,
                     double headingDeg,
                     Double elevationM,
                     double lengthM) {
}
