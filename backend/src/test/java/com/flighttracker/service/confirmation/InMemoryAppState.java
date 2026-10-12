package com.flighttracker.service.confirmation;

import com.flighttracker.repository.AppStateRepository;

import com.flighttracker.observability.PhaseLogger;
import org.springframework.mock.env.MockEnvironment;

import java.time.Clock;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/** app_state without a database, for tests that only need the key/value behaviour. */
final class InMemoryAppState extends AppStateRepository {

    final Map<String, String> rows = new HashMap<>();

    InMemoryAppState(Clock clock) {
        super(null, clock);
    }

    /** Budgets over a fresh in-memory app_state, with the given global daily budget and no per-provider keys. */
    static ConfirmationBudgets budgets(Clock clock, int dailyBudget) {
        return new ConfirmationBudgets(new InMemoryAppState(clock), clock, new MockEnvironment(), new PhaseLogger(), dailyBudget);
    }

    @Override
    public Optional<String> get(String key) {
        return Optional.ofNullable(rows.get(key));
    }

    @Override
    public void put(String key, String value) {
        rows.put(key, value);
    }

    @Override
    public Map<String, String> getAllWithPrefix(String prefix) {
        Map<String, String> out = new LinkedHashMap<>();
        rows.forEach((k, v) -> {
            if (k.startsWith(prefix)) out.put(k, v);
        });
        return out;
    }
}
