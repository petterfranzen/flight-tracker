import { expect, test } from "@playwright/test";
import { findShadowedIds } from "../src/map/staleness";
import { newerReport, notOlderReport, observedAtMs, sameReport } from "../src/map/reportOrder";

// `observedAt` is ordered by the instant it names, not by its text. The server
// can spell one instant in more than one way — an offset instead of `Z`,
// fractional seconds or none — and the text order then disagrees with the
// timeline: a report that is actually older can sort after a newer one. These
// are the cases where the two orders diverge; main.ts orders every payload
// through these helpers (frameAdvances, newerOf), so on a stale report a
// WebSocket frame no longer moves a marker backwards (#150).
//
// Pure and map-free: no page, no fixtures — the ordering is the whole subject.

test.describe("observedAt ordering", () => {
  test("orders by instant, not text, when one report carries a UTC offset (+02:00 vs Z)", () => {
    const withOffset = "2026-01-01T10:00:00+02:00"; // 08:00Z
    const utc = "2026-01-01T09:00:00Z"; // 09:00Z
    // The text order and the instant order disagree...
    expect(withOffset > utc, "the text says the +02:00 report is later").toBe(true);
    expect(observedAtMs(withOffset), "but 10:00+02:00 is 08:00Z").toBeLessThan(observedAtMs(utc));
    // ...and the helpers follow the instant: 09:00Z is the later report.
    expect(newerReport(utc, withOffset), "09:00Z is the later instant").toBe(true);
    expect(newerReport(withOffset, utc), "08:00Z is not newer than 09:00Z").toBe(false);
  });

  test("orders by instant, not text, when one spelling carries fractional seconds", () => {
    const withMs = "2026-01-01T10:00:00.500Z";
    const wholeSecond = "2026-01-01T10:00:00Z";
    expect(withMs < wholeSecond, "the text puts '.500Z' before 'Z'").toBe(true);
    expect(newerReport(withMs, wholeSecond), "half a second past is the later instant").toBe(true);
    expect(newerReport(wholeSecond, withMs), "the whole second is the earlier one").toBe(false);
    // "at or after" leans the same way.
    expect(notOlderReport(withMs, wholeSecond)).toBe(true);
    expect(notOlderReport(wholeSecond, withMs)).toBe(false);
  });

  test("treats two spellings of one instant as the same report", () => {
    expect("2026-01-01T09:00:00Z" === "2026-01-01T10:00:00+01:00", "the text says they differ").toBe(false);
    expect(sameReport("2026-01-01T09:00:00Z", "2026-01-01T10:00:00+01:00")).toBe(true);
    expect(sameReport("2026-01-01T09:00:00Z", "2026-01-01T09:00:00.000Z")).toBe(true);
    // Same report, so neither is strictly newer.
    expect(newerReport("2026-01-01T09:00:00Z", "2026-01-01T10:00:00+01:00")).toBe(false);
    expect(newerReport("2026-01-01T09:00:00Z", "2026-01-01T09:00:00.000Z")).toBe(false);
  });
});

// staleness.findShadowedIds keeps the newest of a group of overlapping reports,
// so it must pick "newest" by instant too (#175).
test.describe("staleness: newest by instant", () => {
  const at = (icao24: string, observedAt: string) => ({
    icao24,
    callsign: null,
    observedAt,
    latitude: 59.65,
    longitude: 17.92,
    headingDeg: null,
  });

  test("Z vs +00:00 spelling of one report does not hide the genuinely newer one", () => {
    // As text "10:00:00.250+00:00" < "10:00:00Z" ('.' sorts before 'Z'), so the newer report read as older.
    const shadowed = findShadowedIds([at("old", "2026-01-01T10:00:00Z"), at("new", "2026-01-01T10:00:00.250+00:00")]);
    expect([...shadowed]).toEqual(["old"]);
  });

  test("an offset spelling is ordered by its instant", () => {
    // 10:00+02:00 is 08:00Z, older than 09:00Z although its text is greater.
    const shadowed = findShadowedIds([at("offset", "2026-01-01T10:00:00+02:00"), at("utc", "2026-01-01T09:00:00Z")]);
    expect([...shadowed]).toEqual(["offset"]);
  });

  test("fractional seconds: 10:00:00.500Z is newer than 10:00:00Z", () => {
    const shadowed = findShadowedIds([at("whole", "2026-01-01T10:00:00Z"), at("frac", "2026-01-01T10:00:00.500Z")]);
    expect([...shadowed]).toEqual(["whole"]);
  });
});

// A report whose `observedAt` is missing or unparseable must not throw, and the
// order must not wobble run to run: `findShadowedIds` sorts by the parsed
// instant, and one that will not parse sorts as a tie (observedAtMs -> NaN,
// held to 0 by the `|| 0` guard) so the input order decides (#178 QA).
test.describe("staleness: unparseable observedAt", () => {
  const at = (icao24: string, observedAt: string) => ({
    icao24,
    callsign: null,
    observedAt,
    latitude: 59.65,
    longitude: 17.92,
    headingDeg: null,
  });

  test("an invalid observedAt does not throw", () => {
    expect(() => findShadowedIds([at("bad", "not-a-date"), at("good", "2026-01-01T10:00:00Z")])).not.toThrow();
  });

  test("an empty observedAt does not throw", () => {
    expect(() => findShadowedIds([at("empty", ""), at("good", "2026-01-01T10:00:00Z")])).not.toThrow();
  });

  test("an unparseable report does not hide a valid newer one", () => {
    // Same spot, so the two overlap; the newest valid report must survive.
    const shadowed = findShadowedIds([at("newest", "2026-01-01T10:00:00.500Z"), at("bad", "not-a-date")]);
    expect([...shadowed]).not.toContain("newest");
    expect([...shadowed]).toEqual(["bad"]);
  });

  test("invalid and empty observedAt tie deterministically across repeated runs", () => {
    const list = [
      at("newest", "2026-01-01T10:00:00.500Z"),
      at("bad", "not-a-date"),
      at("empty", ""),
      at("oldest", "2026-01-01T09:00:00Z"),
      at("middle", "2026-01-01T09:30:00Z"),
    ];
    const first = [...findShadowedIds(list)];
    // The newest valid report survives; every other marker is shadowed by it.
    expect(first).not.toContain("newest");
    expect(first.length).toBe(list.length - 1);
    for (let i = 0; i < 50; i++) {
      expect([...findShadowedIds(list)], `run ${i} differed from the first`).toEqual(first);
    }
  });

  test("a list of only unparseable reports keeps the input order, stably", () => {
    const list = [at("a", "nope"), at("b", ""), at("c", "still-nope")];
    const first = [...findShadowedIds(list)];
    // All three tie; the first is placed, the rest are shadowed in input order.
    expect(first).toEqual(["b", "c"]);
    for (let i = 0; i < 50; i++) {
      expect([...findShadowedIds(list)]).toEqual(first);
    }
  });
});
