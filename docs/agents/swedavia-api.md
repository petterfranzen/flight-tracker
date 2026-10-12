# Swedavia FlightInfo API v2: contract notes (P3b-R)

Researched 2026-10-12 from public sources only. **No authenticated call was made.** The open items at the end need checking with a real key.

The main source is https://apideveloper.swedavia.se/content/Using_the_FlightInfo_API.pdf (model 2.0.0), "the PDF" below. Also:
- the FAQ: https://apideveloper.swedavia.se/faq
- the general API PDF: https://apideveloper.swedavia.se/content/General_API_information.pdf
- the operational API PDF: https://apideveloper.swedavia.se/content/Using_the_operational_flightInfo_API.pdf
- the key-rotation PDF: https://apideveloper.swedavia.se/content/keyrotation-2025_2030.pdf

Third-party code that calls the API, used for structural evidence: `seb-emmot/sviago` (Go structs), `abodi99/taxitips`, `katryl-yh/svensk-flyt`, `ChrispyPie/taxikit-shop` and `benKrt1/SwedaviaFlightInfo`.

## Endpoints and auth
- Arrivals board: `GET https://api.swedavia.se/flightinfo/v2/{airportIATA}/arrivals/{yyyy-mm-dd}`.
  - The PDF says the date is UTC. A third-party measurement found the board covers the **local Swedish date**, so when a window crosses local midnight, fetch both dates.
  - There is no pagination: one body with `numberOfFlights` and `flights[]`. An ARN day is about 270 flights.
- `/query` (OData filter plus `continuationToken` for "changed since"):
  - A third party reports it returned 0 flights for valid filters.
  - Where the continuation token appears in the response is undocumented.
  - **Use the per-airport endpoint.**
- Headers:
  - `Ocp-Apim-Subscription-Key: <key>` and `Accept: application/json`.
  - `Cache-Control: no-cache` is used by clients but not required.
- Errors:
  - 401 or 403 means a missing or wrong key.
  - 400 `{"errors":["Date does not contain a valid date."]}` means the date is outside the window. The window is documented as 7 days back to 90 days ahead; treat 6 days back as the safe limit.
- Keys rotate: primary and secondary alternate every 6 months. Next dates: 2026-10-02 (secondary), 2027-03-31 (primary). Support a secondary key.

## Arrival fields (real JSON is camelCase)
- Board level:
  - `to.arrivalAirportIata`, `to.arrivalAirportIcao`, `to.flightArrivalDate`
  - `numberOfFlights`
  - `flights[]`
- Each flight:
  - `flightId` (e.g. `SK1402`)
  - `airlineOperator.{iata,icao,name}`
  - `arrivalTime.{scheduledUtc,estimatedUtc,actualUtc}`. These are nullable and often absent.
  - `locationAndStatus.{terminal,gate,flightLegStatus,flightLegStatusSwedish,flightLegStatusEnglish}`. The whole block may be missing.
  - `baggage.{estimatedFirstBagUtc,firstBagUtc,lastBagUtc,baggageClaimUnit}`
  - `codeShareData[]`
  - `flightLegIdentifier.{ifplId,callsign,aircraftRegistration,ssrCode,flightId,flightDepartureDateUtc,departureAirportIata,arrivalAirportIata,departureAirportIcao,arrivalAirportIcao}`
  - `remarksEnglish[]` and `remarksSwedish[]`, each `{text,indicator}` (FIDS text such as "Landat 11:04")
  - `viaDestinations[]`
  - `diIndicator` (D, I or S). It may sit at flight level or inside `flightLegIdentifier`, so read both.
- `flightLegStatus` codes:

  | Code | Meaning |
  |---|---|
  | SCH | Scheduled |
  | FPL | Flight plan |
  | FLS | Flight suspended |
  | SEQ | Sequenced |
  | ACT | Active |
  | CAN | Cancelled |
  | LAN | Landed |
  | RER | Rerouted |
  | DIV | Diverted |
  | DEL | **Deleted** (not "delayed") |

  - There is **no in-block or at-gate code.**
  - "SCH often never flips to LAN", so use the presence of `actualUtc` together with the status.
- Timestamps: probably ISO with a `Z`; parse tolerantly. Absent fields are probably omitted rather than sent as null; handle both.

## Semantics (design decisions for the provider)
- **`actualUtc` is ambiguous** (touchdown or in-block; the docs only say "actual time of arrival"). The provider maps it to `ArrivalInfo.actualOn`, which gives LANDED_CONFIRMED, and documents that it is an upper bound on touchdown.
- **At gate is inferred from baggage.** `baggage.firstBagUtc` present means bags are on the belt, so the aircraft has parked. The provider sets `actualIn = firstBagUtc` (an upper bound on in-block), which gives AT_GATE with `locationAndStatus.gate`.
- `CAN`, `DEL` and `DIV` never confirm a landing at that airport.
- Match on `flightLegIdentifier.callsign` (ICAO, e.g. `SAS1402`), then `aircraftRegistration`.

## Airports (IATA → ICAO)
| IATA | ICAO | Airport |
|---|---|---|
| ARN | ESSA | Stockholm Arlanda |
| BMA | ESSB | Bromma Stockholm |
| GOT | ESGG | Göteborg Landvetter |
| MMX | ESMS | Malmö |
| LLA | ESPA | Luleå |
| UME | ESNU | Umeå |
| OSD | ESNZ | Åre Östersund |
| VBY | ESSV | Visby |
| RNB | ESDF | Ronneby |
| KRN | ESNQ | Kiruna |

The ICAO codes are standard but not in Swedavia's docs. The API returns `to.arrivalAirportIcao`, which confirms them live.

## Limits and terms
- **Quota:** the free tier is about 10,000 requests/month (some third parties say "10,001 per 30 days"). An email arrives near the limit, then access is **blocked for the rest of the month**. There are no quota headers, so count calls client-side.
  - Over-quota status is undocumented; 429 is likely. Treat a 429 that persists for a whole day as quota exhaustion.
- **Rate:** calls less than about 2 s apart gave 429 (third-party report; it matches the operational API's documented "one call per two seconds"). Space calls ≥ 2 s apart.
- **Freshness:** update frequency is undocumented. The `Last-Modified` response header shows the last global data change. Third parties poll every 5 min.
- **Terms:** no licence, attribution or caching terms were found publicly. **Read them at sign-up** before going live.

## Open items for a live check (once a key exists)
1. Is the board's `{date}` UTC or local, and what is the exact timestamp format?
2. Is `diIndicator` at flight level or inside `flightLegIdentifier`?
3. What does `actualUtc` mean? Compare it with the "Landat HH:MM" remark.
4. What is the over-quota HTTP status and its headers?
5. What does the real `to` block look like?
