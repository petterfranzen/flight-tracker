package com.flighttracker.ops;

import java.time.Instant;

/**
 * What GET /api/ops/stats returns: numbers only. Field names describe what
 * is measured, never the runtime, database, OS or providers behind it, and
 * nothing here carries a path, host, version or library name. Any value the
 * host can't provide is null.
 */
public record OpsStats(Instant at, Long uptimeSeconds, Memory memory, Io io, Cpu cpu, Data data, Freshness freshness) {

    /**
     * currentBytes/softLimitBytes/hardLimitBytes: the service's memory and
     * its limits. appBytes: memory the process itself holds. cacheBytes:
     * file cache charged to the service. cacheRefaultsTotal: cached pages
     * read back after eviction (rising = the cache is being squeezed).
     * softLimitEventsTotal: times the soft limit forced reclaim. pressure*:
     * share of time stalled on memory, in percent. managed*: the language
     * runtime's own managed memory.
     */
    public record Memory(Long currentBytes, Long softLimitBytes, Long hardLimitBytes,
                         Long appBytes, Long cacheBytes, Long cacheRefaultsTotal, Long majorFaultsTotal,
                         Long softLimitEventsTotal, Long hardLimitEventsTotal, Long outOfMemoryKillsTotal,
                         Double pressureSomeAvg10, Double pressureSomeAvg60,
                         Double pressureFullAvg10, Double pressureFullAvg60,
                         Long residentBytes, Long managedUsedBytes, Long managedCommittedBytes, Long managedMaxBytes) {}

    /** Bytes the process has read from and written to storage since it started. */
    public record Io(Long readBytesTotal, Long writeBytesTotal) {}

    public record Cpu(Double cpuSecondsTotal, Double loadAverage1m) {}

    /** storeBytes: the on-disk size of the app's data, including its write log. */
    public record Data(Long storeBytes) {}

    /** lastSweepAt: last completed worldwide refresh. aircraftSeenLast10m: airborne aircraft reported in the last 10 minutes. */
    public record Freshness(Instant lastSweepAt, Long aircraftSeenLast10m) {}
}
