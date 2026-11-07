import { expect, test } from "@playwright/test";
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
  test("orders by instant, not text, when the same moment is spelled with an offset", () => {
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
