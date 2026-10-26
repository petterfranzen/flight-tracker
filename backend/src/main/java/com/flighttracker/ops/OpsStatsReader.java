package com.flighttracker.ops;

import com.flighttracker.service.agent.SweepHealthTracker;
import com.flighttracker.service.live.LiveStateStore;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads the numbers behind OpsStats from the kernel's per-process and
 * per-service files (the service's memory limit counts the file cache, so
 * its stats show whether the cache is being squeezed) and from the process
 * itself. Every source is optional: a file that is missing or unreadable
 * gives nulls, never an error that could carry a path to the caller.
 */
@Component
public class OpsStatsReader {

    private final Path proc;
    private final Path serviceRoot;
    private final Path store;
    private final SweepHealthTracker sweepHealthTracker;
    private final LiveStateStore liveStateStore;
    private final Clock clock;

    @Autowired
    public OpsStatsReader(@Value("${flighttracker.db-path:./data/flighttracker.db}") String storePath,
                          SweepHealthTracker sweepHealthTracker, LiveStateStore liveStateStore, Clock clock) {
        this(Path.of("/proc"), Path.of("/sys/fs/cgroup"), Path.of(storePath), sweepHealthTracker, liveStateStore, clock);
    }

    OpsStatsReader(Path proc, Path serviceRoot, Path store,
                   SweepHealthTracker sweepHealthTracker, LiveStateStore liveStateStore, Clock clock) {
        this.proc = proc;
        this.serviceRoot = serviceRoot;
        this.store = store;
        this.sweepHealthTracker = sweepHealthTracker;
        this.liveStateStore = liveStateStore;
        this.clock = clock;
    }

    public OpsStats read() {
        Instant now = clock.instant();
        Path service = serviceDir();
        Map<String, Long> stat = service == null ? Map.of() : keyValues(service.resolve("memory.stat"));
        Map<String, Long> events = service == null ? Map.of() : keyValues(service.resolve("memory.events"));
        Map<String, Double> pressure = service == null ? Map.of() : pressure(service.resolve("memory.pressure"));
        Map<String, Long> io = keyValues(proc.resolve("self/io"));
        Runtime runtime = Runtime.getRuntime();

        OpsStats.Memory memory = new OpsStats.Memory(
                service == null ? null : single(service.resolve("memory.current")),
                service == null ? null : single(service.resolve("memory.high")),
                service == null ? null : single(service.resolve("memory.max")),
                stat.get("anon"), stat.get("file"), stat.get("workingset_refault_file"), stat.get("pgmajfault"),
                events.get("high"), events.get("max"), events.get("oom_kill"),
                pressure.get("some.avg10"), pressure.get("some.avg60"),
                pressure.get("full.avg10"), pressure.get("full.avg60"),
                residentBytes(),
                runtime.totalMemory() - runtime.freeMemory(), runtime.totalMemory(), runtime.maxMemory());

        Double cpuSeconds = ProcessHandle.current().info().totalCpuDuration()
                .map(d -> d.toMillis() / 1000.0).orElse(null);

        return new OpsStats(
                now,
                ManagementFactory.getRuntimeMXBean().getUptime() / 1000,
                memory,
                new OpsStats.Io(io.get("read_bytes"), io.get("write_bytes")),
                new OpsStats.Cpu(cpuSeconds, loadAverage()),
                new OpsStats.Data(storeBytes()),
                new OpsStats.Freshness(sweepHealthTracker.lastSweepAt().orElse(null),
                        liveStateStore.countActive(now.minus(Duration.ofMinutes(10)))));
    }

    /** This process's service directory, from the "0::/path" line of /proc/self/cgroup. */
    private Path serviceDir() {
        for (String line : lines(proc.resolve("self/cgroup"))) {
            if (!line.startsWith("0::")) continue;
            String relative = line.substring(3).replaceFirst("^/+", "");
            Path dir = serviceRoot.resolve(relative).normalize();
            return dir.startsWith(serviceRoot.normalize()) && Files.isDirectory(dir) ? dir : null;
        }
        return null;
    }

    private Long residentBytes() {
        for (String line : lines(proc.resolve("self/status"))) {
            if (!line.startsWith("VmRSS:")) continue;
            String[] parts = line.substring(6).trim().split("\\s+");
            Long kib = parseLong(parts[0]);
            return kib == null ? null : kib * 1024;
        }
        return null;
    }

    private Double loadAverage() {
        List<String> lines = lines(proc.resolve("loadavg"));
        if (lines.isEmpty()) return null;
        try {
            return Double.parseDouble(lines.get(0).trim().split("\\s+")[0]);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private Long storeBytes() {
        long total = 0;
        boolean any = false;
        for (Path p : List.of(store, Path.of(store + "-wal"))) {
            try {
                total += Files.size(p);
                any = true;
            } catch (IOException | RuntimeException ignored) {
                // absent write log is normal
            }
        }
        return any ? total : null;
    }

    /** "key value" lines (memory.stat, memory.events) or "key: value" lines (/proc/self/io). */
    static Map<String, Long> keyValues(Path file) {
        Map<String, Long> out = new HashMap<>();
        for (String line : lines(file)) {
            String[] parts = line.trim().split("[:\\s]+");
            if (parts.length < 2) continue;
            Long value = parseLong(parts[1]);
            if (value != null) out.put(parts[0], value);
        }
        return out;
    }

    /** "some avg10=0.00 avg60=0.00 avg300=0.00 total=0" lines, keyed "some.avg10" etc. */
    static Map<String, Double> pressure(Path file) {
        Map<String, Double> out = new HashMap<>();
        for (String line : lines(file)) {
            String[] parts = line.trim().split("\\s+");
            if (parts.length < 2) continue;
            for (int i = 1; i < parts.length; i++) {
                int eq = parts[i].indexOf('=');
                if (eq <= 0) continue;
                try {
                    out.put(parts[0] + "." + parts[i].substring(0, eq), Double.parseDouble(parts[i].substring(eq + 1)));
                } catch (NumberFormatException ignored) {
                    // skip
                }
            }
        }
        return out;
    }

    /** A one-number file; "max" (no limit) and anything unreadable give null. */
    static Long single(Path file) {
        List<String> lines = lines(file);
        return lines.isEmpty() ? null : parseLong(lines.get(0).trim());
    }

    private static List<String> lines(Path file) {
        try {
            return Files.readAllLines(file);
        } catch (IOException | RuntimeException e) {
            return List.of();
        }
    }

    private static Long parseLong(String s) {
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
