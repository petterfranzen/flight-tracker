package com.flighttracker.service.agent;

import com.flighttracker.repository.AircraftRepository;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * A restart mid-run must not leave retention working through its whole
 * max-batches-per-run backlog while systemd's TimeoutStopSec counts down.
 */
class PositionRetentionServiceTest {

    private static final int BATCH = 100;

    @Test
    void contextCloseStopsTheRunAfterTheCurrentBatch() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        TransactionTemplate tx = mock(TransactionTemplate.class);
        when(tx.execute(any())).thenAnswer(inv -> ((TransactionCallback<?>) inv.getArgument(0)).doInTransaction(null));

        PositionRetentionService retention = new PositionRetentionService(jdbc, mock(AircraftRepository.class), tx,
                Clock.fixed(Instant.parse("2026-10-01T12:00:00Z"), ZoneOffset.UTC));
        ReflectionTestUtils.setField(retention, "retentionHours", 72.0);
        ReflectionTestUtils.setField(retention, "batchSize", BATCH);
        ReflectionTestUtils.setField(retention, "maxBatchesPerRun", 200);

        // Every batch comes back full (a big backlog); shutdown starts during the second.
        AtomicInteger batches = new AtomicInteger();
        when(jdbc.update(anyString(), anyLong(), any())).thenAnswer(inv -> {
            if (batches.incrementAndGet() == 2) retention.stopAfterCurrentBatch();
            return BATCH;
        });

        retention.prune();

        assertThat(batches).hasValue(2);
    }
}
