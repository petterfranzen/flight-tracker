package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.repository.AppStateRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.Map;

/**
 * Per-provider call budgets in cost units: a UTC-day budget that resets at
 * midnight and a UTC-month budget that resets on the 1st. Limits come from
 * {@code flighttracker.confirmation.providers.<id>.daily-budget} and
 * {@code .monthly-budget}; a missing monthly budget is unlimited and a
 * missing daily one falls back to the global {@code flighttracker.confirmation.daily-budget}.
 *
 * <p>The counters are written through to {@code app_state} on every charge
 * (one key per provider, {@code confirmation.budget.<id>}, value
 * {@code <day>:<units>|<month>:<units>}) and read back lazily on first use, so
 * a restart cannot spend a monthly quota twice. A write per upstream call is
 * cheap: the gateway's minimum interval already allows at most one call per
 * provider per 30 s, and batching would lose the very units a crash is meant
 * to preserve. If app_state is unreadable or unwritable the in-memory counts
 * still apply and a warning is logged.
 *
 * <p>Charging happens before the call (an estimate of its cost) and is
 * corrected with {@link #adjust} once the real cost is known, so a call that
 * dies mid-flight is still counted. When a monthly budget passes 80% one
 * {@link PhaseLogger#degraded} line is logged per provider and month.
 */
@Component
public class ConfirmationBudgets {

    private static final Logger log = LoggerFactory.getLogger(ConfirmationBudgets.class);
    static final String KEY_PREFIX = "confirmation.budget.";
    static final double WARN_FRACTION = 0.8;

    private static final class Counter {
        Integer dailyLimit;
        Integer monthlyLimit;
        LocalDate day;
        int dayUnits;
        YearMonth month;
        int monthUnits;
        boolean warned;
    }

    private final AppStateRepository appState;
    private final Clock clock;
    private final Environment env;
    private final PhaseLogger phaseLogger;
    private final int defaultDailyBudget;
    private final Map<String, Counter> counters = new HashMap<>();

    public ConfirmationBudgets(AppStateRepository appState,
                               Clock clock,
                               Environment env,
                               PhaseLogger phaseLogger,
                               @Value("${flighttracker.confirmation.daily-budget:300}") int defaultDailyBudget) {
        this.appState = appState;
        this.clock = clock;
        this.env = env;
        this.phaseLogger = phaseLogger;
        this.defaultDailyBudget = defaultDailyBudget;
    }

    /** Charges {@code units} if both budgets have room for them; false (and nothing charged) otherwise. */
    public synchronized boolean tryCharge(String providerId, int units) {
        Counter c = counter(providerId);
        if (c.dailyLimit != null && c.dayUnits + units > c.dailyLimit) return false;
        if (c.monthlyLimit != null && c.monthUnits + units > c.monthlyLimit) return false;
        add(providerId, c, units);
        return true;
    }

    /** Corrects an earlier charge once the real cost is known (negative refunds). May overshoot a limit. */
    public synchronized void adjust(String providerId, int deltaUnits) {
        if (deltaUnits == 0) return;
        add(providerId, counter(providerId), deltaUnits);
    }

    public synchronized int unitsToday(String providerId) {
        return counter(providerId).dayUnits;
    }

    public synchronized int unitsThisMonth(String providerId) {
        return counter(providerId).monthUnits;
    }

    private void add(String providerId, Counter c, int units) {
        c.dayUnits = Math.max(0, c.dayUnits + units);
        c.monthUnits = Math.max(0, c.monthUnits + units);
        persist(providerId, c);
        if (c.monthlyLimit != null && !c.warned && c.monthUnits >= WARN_FRACTION * c.monthlyLimit) {
            c.warned = true;
            String detail = "Arrival provider " + providerId + " has used " + c.monthUnits + " of its "
                    + c.monthlyLimit + " monthly units";
            log.warn(detail); // PhaseLogger prints on a phase change only; this line is always there
            phaseLogger.degraded(detail);
        }
    }

    /** The provider's counter, loaded on first use and rolled over to the current UTC day and month. */
    private Counter counter(String providerId) {
        Counter c = counters.get(providerId);
        if (c == null) {
            c = new Counter();
            String prefix = "flighttracker.confirmation.providers." + providerId + ".";
            c.dailyLimit = env.getProperty(prefix + "daily-budget", Integer.class, defaultDailyBudget);
            c.monthlyLimit = env.getProperty(prefix + "monthly-budget", Integer.class);
            load(providerId, c);
            counters.put(providerId, c);
        }
        LocalDate today = clock.instant().atZone(ZoneOffset.UTC).toLocalDate();
        if (!today.equals(c.day)) {
            c.day = today;
            c.dayUnits = 0;
        }
        YearMonth thisMonth = YearMonth.from(today);
        if (!thisMonth.equals(c.month)) {
            c.month = thisMonth;
            c.monthUnits = 0;
            c.warned = false;
        }
        return c;
    }

    private void load(String providerId, Counter c) {
        try {
            String value = appState.get(KEY_PREFIX + providerId).orElse(null);
            if (value == null) return;
            String[] parts = value.split("\\|");
            String[] day = parts[0].split(":");
            String[] month = parts[1].split(":");
            c.day = LocalDate.parse(day[0]);
            c.dayUnits = Integer.parseInt(day[1]);
            c.month = YearMonth.parse(month[0]);
            c.monthUnits = Integer.parseInt(month[1]);
        } catch (RuntimeException e) {
            log.warn("Could not read the stored budget of confirmation provider {}, starting from zero", providerId, e);
        }
    }

    private void persist(String providerId, Counter c) {
        try {
            appState.put(KEY_PREFIX + providerId, c.day + ":" + c.dayUnits + "|" + c.month + ":" + c.monthUnits);
        } catch (RuntimeException e) {
            log.warn("Could not store the budget of confirmation provider {}", providerId, e);
        }
    }
}
