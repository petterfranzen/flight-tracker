# Swedavia FlightInfo fixtures

**Reconstructed, not recorded.** No authenticated call has been made to the Swedavia API.
These files are built from the field list in `docs/agents/swedavia-api.md` (the public
"Using the FlightInfo API" PDF, model 2.0.0, and third-party client code), so the shapes
are plausible, not verified. Replace them with a real recording once a key exists.

- `arn-arrivals-2026-10-12.json`: an ARN board with the cases the provider maps:
  landed with gate and bags (SAS1402), landed without bags (SAS1404), scheduled (NOZ4001),
  deleted (SAS2012), diverted (SAS1500), no `locationAndStatus` and a timestamp without `Z`
  (FIN861), a registration-only entry with nulls and an unknown field (SE-RUB).
- `empty-arrivals.json`: a board with no flights.
- `error-400-date.json`: the body of a 400 for a date outside the window.
