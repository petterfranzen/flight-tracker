Model: sonnet

# Find flights by route: from one place to another

The human asked for this (2026-10-12): "find flights with arrival and
departure destination, for example from London to Barcelona."

## What exists today
- The advanced search's single **airport** field (`GET /api/flights/search?airport=…`,
  `FlightController.searchByAirport`, frontend `ui/flightSearch.ts` →
  `searchFlightsByAirport`) matches a live aircraft whose **origin OR destination**
  matches the text.
- The text is resolved once to airport codes (`AirportRepository.findIcaoCodesMatching`),
  matching ICAO code, IATA code, name or municipality. So "Kalmar" finds ESMQ, and
  "London" should find every London airport.
- Then every live aircraft is matched in memory against its current flight's route,
  by callsign (`CallsignRouteService`, the `callsign_route` table). Never use the
  legacy `aircraft.origin_*`/`destination_*` columns (CLAUDE.md).

## Build
1. **Backend:** extend `/api/flights/search` with `from` and `to` parameters.
   - Resolve each to a set of ICAO codes the same way the airport field does.
   - Match a live aircraft when its route's origin is in `from` **and** its
     destination is in `to`.
   - Either side may be empty ("from London" alone means "anywhere from London").
   - Keep `airport` (origin OR destination) working unchanged.
   - Results are sorted by callsign, limited like today. Unit and controller tests:
     "London" → LHR, LGW, STN, LTN, LCY, SEN (check `airports.tsv` municipality
     values; "London" may also match London, Ontario, CYXU, so decide whether to
     rank by size or show the country); "Barcelona" → LEBL; a route with no match →
     empty.
2. **Frontend:** in the advanced search panel, add **From** and **To** fields (with a
   swap button), next to the existing airport field or replacing it as a third mode.
   Same result list and click-to-fly behaviour. Follow the theme tokens and the
   Playwright rules in CLAUDE.md ("Writing tests that don't flake"). Add a spec with a
   mocked `/search?from=London&to=Barcelona`.
3. **Blackbox:** a `from`/`to` query returns 200 and an array.

## Scope notes
- This searches **live and recently landed** flights only, like the rest of the app.
  Future scheduled departures would need a schedule source; out of scope.
- City matching depends on `airports.tsv` municipality names. Mention in the PR any
  big city whose airports don't resolve (e.g. "Stockholm" → ESSA, ESSB, ESKN, ESOW?).

## Done when
CI is green on the PR, and the human can type "London" → "Barcelona" and see the
live LHR/LGW/STN/LTN/LCY/SEN → BCN flights.
