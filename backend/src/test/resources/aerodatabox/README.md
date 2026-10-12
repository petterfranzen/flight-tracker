# AeroDataBox fixtures

No authenticated call to AeroDataBox has been made, and `docs/agents/aerodatabox-api.md` holds no
sample payload. **Every file here is reconstructed** from the OpenAPI spec (v1.15.4.0) field names and
the documented time format (`"2025-01-12 05:09Z"` for UTC, `"2025-01-12 06:09+01:00"` for local); the
values are invented. Replace `cx271-two-days.json` with a real response when a key exists (open item 4
in the notes).

All are arrays, as the "nearest flight" endpoint answers. Flight CX 271 (callsign CPA271, Hong Kong to
Amsterdam), expected on 2026-10-12.

| File | What it shows |
|---|---|
| `cx271-two-days.json` | Two entries on adjacent days (11th and 12th), both Arrived with equal runway and revised times: touchdown only, no gate time. The 11th has a gate, the 12th does not |
| `arrived-at-gate.json` | Arrived, `revisedTime` 12 min later than `runwayTime`, with a gate: AT_GATE |
| `approaching.json` | Approaching, estimated (revised) time only, no runway time: no actual times |
| `canceled.json` | Canceled: no landing |
| `operator-and-codeshare.json` | A codeshare entry (KL 3871, IsCodeshared) listed before the operator's, with a different gate and a later touchdown |
| `modes-mismatch.json` | `aircraft.modeS` differs from the airframe being asked about |
