# AeroDataBox: contract notes (P3c-R)

Researched 2026-10-12 from the public OpenAPI spec (v1.15.4.0, https://doc.aerodatabox.com/docs/openapi-rapidapi-v1.json), https://aerodatabox.com/pricing/, /data-coverage/, /terms and /faq, plus open-source clients (`dpage/aerly`, `LeungYuLap19/SYP-Chatbot`). **No authenticated call was made.**

## Access
- **Channel:** RapidAPI is the one with a "free forever" Basic plan.
  - Base `https://aerodatabox.p.rapidapi.com`.
  - Headers `X-RapidAPI-Key: <key>` and `X-RapidAPI-Host: aerodatabox.p.rapidapi.com` (both mandatory).
  - Self-service sign-up at rapid.aerodatabox.com.
- **Basic plan:** 400 units/month, 1 req/s (plus 1,000 req/h). **Non-commercial only. Attribution is required.**
- **Paid plans:** Pro is $8/month for 5,000 units.

## Endpoint (per-flight)
- Use `GET /flights/{searchBy}/{searchParam}?withAircraftImage=false&withLocation=false`, the **nearest flight** variant: no date, **Tier 2 = 2 units**.
  - `searchBy` is `Number|CallSign|Reg|Icao24` (use this casing).
  - Number search accepts an IATA *or ICAO* flight number (e.g. `SAS1402`).
- The dated variant `/flights/{searchBy}/{param}/{dateLocal}?dateLocalRole=Arrival` costs the same but needs the arrival airport's **local** date, and we store no airport time zones.
- **200** returns an **array** (adjacent days, multi-leg flights, codeshares). **204** means not found.
- Time strings are **not ISO**: `"2025-01-12 05:09Z"` (UTC) and `"2025-01-12 06:09+01:00"` (local). Parse with a custom pattern.

## Fields
- `arrival.airport.icao`
- `arrival.scheduledTime.utc`, `arrival.revisedTime.utc`, `arrival.runwayTime.utc`
- `arrival.terminal`, `arrival.gate`, `arrival.baggageBelt`, `arrival.runway`
- `arrival.quality[]` (`Basic|Live|Approximate`)
- `number` (with a space, e.g. "CX 271")
- `callSign`
- `status`: `Unknown, Expected, EnRoute, CheckIn, Boarding, GateClosed, Departed, Delayed, Approaching, Arrived, Canceled, Diverted, CanceledUncertain`. There is **no "Landed"**.
- `codeshareStatus` (`Unknown|IsOperator|IsCodeshared`, parse case-insensitively)
- `aircraft.reg`, `aircraft.modeS`
- `lastUpdatedUtc`

## Semantics (provider design)
- **Touchdown:** `arrival.runwayTime.utc` is used when `status == Arrived`. When it is absent, `revisedTime` is used.
- **In-block:** per the spec, `revisedTime` is the gate time **only when `runwayTime` exists and differs** (and is later). Otherwise in-block is unknown, so the state stays LANDED_CONFIRMED.
- **Choosing the entry:** filter on `arrival.airport.icao` == expected, prefer `IsOperator`, then take the entry nearest the expected landing time. Optionally confirm with `aircraft.modeS`/`reg`.
- `Canceled`, `Diverted` and `CanceledUncertain` never confirm a landing.

## Terms (https://aerodatabox.com/terms)
- **¶5.4 attribution on free/trial plans:** it must be "clearly visible", "unambiguously identify AeroDataBox", and link to https://aerodatabox.com where feasible.
- **¶5.3:** commercial use only via paid plans.
- **¶5.5:** cache at most **7 days** on Basic and Pro, and minimise cached volume and duration.
- **¶5.2:** don't circumvent rate limits.
- **¶8.3:** disruptive users may be blocked.

## Open items (need a key)
1. Does `Number/SAS1402` (an ICAO callsign as the number) resolve?
2. Is the monthly quota exhaustion status a 429, and which headers come back?
3. Is any `searchBy` blocked on Basic?
4. A real sample where `revisedTime` differs from `runwayTime`.
