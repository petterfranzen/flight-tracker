# Arrival confirmation providers: research (P3-R)

The research is about sources that can confirm an inferred landing: actual
OOOI times (out, off, on, in) and the arrival gate. Pages were read on
2026-10-12. Nothing was signed up for or called. "Unverified" means a page
was blocked, rendered only with JavaScript, or silent on the point.

## Comparison

| Provider | Actual OOOI | Gate / terminal | Coverage | Free tier and cost | Public hobby display |
|---|---|---|---|---|---|
| **Swedavia FlightInfo v2** | `ArrivalTime.ActualUtc` and `FlightLegStatus` (LAN = landed). Whether ActualUtc is touchdown or in-block is not documented. | Gate, terminal, belt | 10 Swedish airports (ARN, BMA, GOT, MMX, LLA, UME, OSD, VBY, RNB, KRN) | Free, 10,000 requests/month. Premium by email. | Terms page not found |
| Swedavia FlightInfo Operational | ALDT, AIBT, AOBT, ATOT | Gate, stand, terminal | Same airports | Partners only | Not for hobby use |
| **AeroDataBox** | Actual or revised arrival "always" where the airport has a feed. Runway time is rare. | Gate and terminal "sometimes" | Global (live status: SE 81%, NO 94%, NL 100%, UK 71%, US 86%) | Free Basic: 400 units/month, 1 req/s, non-commercial, attribution. Pro about $8 for 5,000 units. | Yes on Basic, with attribution |
| **FlightAware AeroAPI** | actual_out/off/on/in (field names from a third-party reference) | Gate and terminal "where known" | Global | Personal: free up to $5/month (about 1,000 lookups), 10 result sets/min | Personal licence covers "personal or academic" use only. A public site may not qualify; ask FlightAware. |
| Avinor XmlFeed | Status A (arrived) plus a status time | Gate (optional), belt | 43 Norwegian airports | Free, no key; poll at most every ~3 min | Yes, with "Flight data from Avinor" and a link |
| Schiphol Flight API v4 | actualLandingTime (no in-block time) | Gate, terminal, pier | AMS | "Basic use free" | Developer account needed; limits unverified |
| Heathrow API | Unverified | Gates and terminals | LHR | Unverified | Unverified |
| AviationStack | Unverified | Unverified | Global | Free: 100 requests/month, non-commercial. From $49.99/month. | Non-commercial only |
| Aviation Edge | Actual times, gate | Gate, terminal | Global | Free key is "limited". From $299/month. | Unverified |
| AirLabs | Only estimated times documented | arr_gate, arr_terminal | Global | Free quota unverified | Unverified |
| Flightradar24 API | datetime_landed (derived from ADS-B) | None seen | Global | Explorer about $9/month | Unverified |
| Cirium, OAG | Unverified | Unverified | Global | Trials only, then sales-led | No |
| OpenSky `/flights/arrival` | Estimated from ADS-B, nightly batch (previous day or earlier) | None | Global | Credit-based; existing OAuth | Already in use |
| adsb.lol / airplanes.live / ADSBx | None (positions only) | None | Global | Varies | n/a |

## Recommendation (ranked)

1. **Swedavia FlightInfo v2.** Free, official, with gate, terminal and an
   actual arrival time. The response includes callsign and registration, so
   it matches our data directly.
   - Sweden only.
   - Polling ARN once a minute would use about 43,000 requests/month, over the 10,000 quota.
     So poll per airport only when an inferred landing at a Swedavia airport
     needs confirming, and use the continuation token. The cache is shared
     across flights.
   - Check the terms at sign-up.
2. **AeroDataBox** (free Basic, Pro at about $8/month if needed). It is the global fallback.
   - Quality is best-effort, and 400 units/month is small.
   - Use it only after an inference, and cache the result.
   - Attribution is required.
3. **FlightAware AeroAPI Personal.** It has the best OOOI data.
   - The licence may not allow a public website, so check with FlightAware first.

Later regional add-ons: Avinor (free, no key, attribution) and Schiphol.
Skip Cirium, OAG, FlightLabs, Flightradar24 and FAA SWIM. OpenSky's
`/flights/arrival` is only good for a next-day sanity check.

## Sources

- Swedavia: https://apideveloper.swedavia.se/content/Using_the_FlightInfo_API.pdf, https://apideveloper.swedavia.se/faq
- AeroDataBox: https://aerodatabox.com/pricing/, https://aerodatabox.com/data-coverage/
- FlightAware: https://www.flightaware.com/commercial/aeroapi/
- Avinor: https://partner.avinor.no/en/services/flight-data/
- Schiphol: https://developer.schiphol.nl/apis/flight-api/overview
- Heathrow: https://developer.heathrow.com/api-flights
- AviationStack: https://aviationstack.com/product
- AirLabs: https://airlabs.co/docs/flight
- OpenSky: https://openskynetwork.github.io/opensky-api/rest.html
- Cirium: https://developer.flightstats.com/getting-started/
