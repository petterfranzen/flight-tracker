package com.flighttracker.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * Static ICAO-code reference data (name/municipality/country/coordinates),
 * seeded once from a bundled OurAirports CSV — see AirportSeedService.
 * Read-only in practice: nothing in the app ever writes to this table
 * except the one-time seed.
 */
@Entity
@Table(name = "airport")
public class Airport {

    @Id
    @Column(name = "icao_code", length = 4)
    private String icaoCode;

    @Column(name = "iata_code", length = 3)
    private String iataCode;

    private String name;
    private String municipality;
    private String country;
    private Double latitude;
    private Double longitude;

    protected Airport() { }

    public String getIcaoCode() { return icaoCode; }
    public String getIataCode() { return iataCode; }
    public String getName() { return name; }
    public String getMunicipality() { return municipality; }
    public String getCountry() { return country; }
    public Double getLatitude() { return latitude; }
    public Double getLongitude() { return longitude; }
}
