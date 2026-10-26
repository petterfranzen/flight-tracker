package com.flighttracker.ops;

import com.flighttracker.service.agent.SweepHealthTracker;
import com.flighttracker.service.live.LiveStateStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class OpsStatsReaderTest {

    private static final Instant NOW = Instant.parse("2026-10-26T08:00:00Z");

    @TempDir
    Path tmp;

    private OpsStatsReader reader(Path proc, Path services, Path store) {
        LiveStateStore live = mock(LiveStateStore.class);
        when(live.countActive(any())).thenReturn(42L);
        return new OpsStatsReader(proc, services, store, new SweepHealthTracker(), live, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static void write(Path file, String content) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
    }

    @Test
    void readsServiceAndProcessFiles() throws IOException {
        Path proc = tmp.resolve("proc");
        Path services = tmp.resolve("services");
        Path svc = services.resolve("system.slice/app.service");
        write(proc.resolve("self/cgroup"), "0::/system.slice/app.service\n");
        write(svc.resolve("memory.current"), "1500000000\n");
        write(svc.resolve("memory.high"), "1468006400\n");
        write(svc.resolve("memory.max"), "max\n");
        write(svc.resolve("memory.stat"), "anon 1300000000\nfile 150000000\nworkingset_refault_file 9876\npgmajfault 321\n");
        write(svc.resolve("memory.events"), "low 0\nhigh 77\nmax 0\noom 0\noom_kill 0\n");
        write(svc.resolve("memory.pressure"),
                "some avg10=1.50 avg60=2.25 avg300=0.00 total=123\nfull avg10=0.50 avg60=0.75 avg300=0.00 total=45\n");
        write(proc.resolve("self/status"), "Name:\tx\nVmRSS:\t  204800 kB\n");
        write(proc.resolve("self/io"), "rchar: 1\nread_bytes: 4096000\nwrite_bytes: 8192\n");
        write(proc.resolve("loadavg"), "1.63 1.56 0.99 2/300 12345\n");
        Path store = tmp.resolve("data/store.db");
        write(store, "x".repeat(1000));
        write(Path.of(store + "-wal"), "y".repeat(24));

        OpsStats s = reader(proc, services, store).read();

        assertThat(s.at()).isEqualTo(NOW);
        assertThat(s.memory().currentBytes()).isEqualTo(1_500_000_000L);
        assertThat(s.memory().softLimitBytes()).isEqualTo(1_468_006_400L);
        assertThat(s.memory().hardLimitBytes()).isNull();
        assertThat(s.memory().appBytes()).isEqualTo(1_300_000_000L);
        assertThat(s.memory().cacheBytes()).isEqualTo(150_000_000L);
        assertThat(s.memory().cacheRefaultsTotal()).isEqualTo(9876L);
        assertThat(s.memory().majorFaultsTotal()).isEqualTo(321L);
        assertThat(s.memory().softLimitEventsTotal()).isEqualTo(77L);
        assertThat(s.memory().outOfMemoryKillsTotal()).isZero();
        assertThat(s.memory().pressureSomeAvg10()).isEqualTo(1.5);
        assertThat(s.memory().pressureFullAvg60()).isEqualTo(0.75);
        assertThat(s.memory().residentBytes()).isEqualTo(204_800L * 1024);
        assertThat(s.memory().managedMaxBytes()).isPositive();
        assertThat(s.io().readBytesTotal()).isEqualTo(4_096_000L);
        assertThat(s.io().writeBytesTotal()).isEqualTo(8192L);
        assertThat(s.cpu().loadAverage1m()).isEqualTo(1.63);
        assertThat(s.data().storeBytes()).isEqualTo(1024L);
        assertThat(s.freshness().aircraftSeenLast10m()).isEqualTo(42L);
    }

    @Test
    void missingFilesGiveNullsNotErrors() {
        OpsStats s = reader(tmp.resolve("no-proc"), tmp.resolve("no-services"), tmp.resolve("no-store.db")).read();

        assertThat(s.memory().currentBytes()).isNull();
        assertThat(s.memory().appBytes()).isNull();
        assertThat(s.memory().residentBytes()).isNull();
        assertThat(s.io().readBytesTotal()).isNull();
        assertThat(s.cpu().loadAverage1m()).isNull();
        assertThat(s.data().storeBytes()).isNull();
        assertThat(s.freshness().lastSweepAt()).isNull();
    }

    @Test
    void ignoresAServicePathThatEscapesTheRoot() throws IOException {
        Path proc = tmp.resolve("proc");
        Path services = tmp.resolve("services");
        Files.createDirectories(services);
        write(proc.resolve("self/cgroup"), "0::/../outside\n");
        write(tmp.resolve("outside/memory.current"), "123\n");

        assertThat(reader(proc, services, tmp.resolve("s.db")).read().memory().currentBytes()).isNull();
    }
}
