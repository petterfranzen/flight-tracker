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
 * to preserve. If app_state is unwritable the in-memory counts still apply and
 * a warning is logged. If it is unreadable on first use the charge is denied
 * (fail closed) and the read is retried on the next use; nothing is cached, so
 * a transient error cannot reset the stored count. A corrupt or negative stored
 * value counts as spent for its period (day or month) until that rolls over.
 * When a daily or monthly budget runs out, one {@link PhaseLogger#degraded} line
 * (and a warn) is logged per provider and period.
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
        final String providerId;
        final BudgetPeriod<LocalDate> day;
        final BudgetPeriod<YearMonth> month;
        boolean warned;

        Counter(String providerId, Integer dailyLimit, Integer monthlyLimit) {
            this.providerId = providerId;
            day = new BudgetPeriod<>("daily", "00:00 UTC", dailyLimit);
            month = new BudgetPeriod<>("monthly", "the 1st (UTC)", monthlyLimit);
        }
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
        if (c == null) return false; // the stored count could not be read: fail closed, retry the read next time
        if (refuses(c, c.day, units) || refuses(c, c.month, units)) return false;
        add(c, units);
        return true;
    }

    /** True when {@code period} has no room for {@code units}; logs that once per provider and period. */
    private boolean refuses(Counter c, BudgetPeriod<?> period, int units) {
        if (!period.refuses(units)) return false;
        if (period.firstRefusalThisPeriod()) exhausted(c, period.refusalReason());
        return true;
    }

    private void exhausted(Counter c, String why) {
        String detail = "Arrival provider " + c.providerId + " is out of budget: " + why;
        log.warn(detail); // PhaseLogger prints on a phase change only; this line is always there
        phaseLogger.degraded(detail);
    }

    /** Corrects an earlier charge once the real cost is known (negative refunds). May overshoot a limit. */
    public synchronized void adjust(String providerId, int deltaUnits) {
        if (deltaUnits == 0) return;
        Counter c = counter(providerId);
        if (c == null) return;
        add(c, deltaUnits);
    }

    public synchronized int unitsToday(String providerId) {
        Counter c = counter(providerId);
        return c == null ? 0 : c.day.units;
    }

    public synchronized int unitsThisMonth(String providerId) {
        Counter c = counter(providerId);
        return c == null ? 0 : c.month.units;
    }

    private void add(Counter c, int units) {
        c.day.add(units);
        c.month.add(units);
        persist(c);
        if (!c.warned && passedWarnLevel(c.month)) {
            c.warned = true;
            String detail = "Arrival provider " + c.providerId + " has used " + c.month.units + " of its "
                    + c.month.limit + " monthly units";
            log.warn(detail); // PhaseLogger prints on a phase change only; this line is always there
            phaseLogger.degraded(detail);
        }
    }

    private static boolean passedWarnLevel(BudgetPeriod<YearMonth> month) {
        return month.limit != null && month.units >= WARN_FRACTION * month.limit;
    }

    /**
     * The provider's counter, loaded on first use and rolled over to the current UTC day and month.
     * Null when the stored count could not be read: nothing is cached then, so the next use retries
     * the read instead of starting from zero and overwriting the real count.
     */
    private Counter counter(String providerId) {
        LocalDate today = clock.instant().atZone(ZoneOffset.UTC).toLocalDate();
        Counter c = counters.get(providerId);
        if (c == null) {
            c = newCounter(providerId);
            if (!load(c, today)) return null;
            counters.put(providerId, c);
        }
        c.day.rollTo(today);
        if (c.month.rollTo(YearMonth.from(today))) c.warned = false;
        return c;
    }

    private Counter newCounter(String providerId) {
        String prefix = "flighttracker.confirmation.providers." + providerId + ".";
        return new Counter(providerId,
                env.getProperty(prefix + "daily-budget", Integer.class, defaultDailyBudget),
                env.getProperty(prefix + "monthly-budget", Integer.class));
    }

    /**
     * Reads the stored count into {@code c}. False when app_state could not be read (nothing is
     * cached; fail closed). A value that is there but corrupt or negative blocks the affected period
     * until it rolls over, and is logged once (a loaded counter is cached).
     */
    private boolean load(Counter c, LocalDate today) {
        String providerId = c.providerId;
        String value;
        try {
            value = appState.get(KEY_PREFIX + providerId).orElse(null);
        } catch (RuntimeException e) {
            log.warn("Could not read the stored budget of confirmation provider {}; no calls until it can be read", providerId, e);
            return false;
        }
        if (value != null && !readStored(value, c, today)) {
            log.warn("The stored budget of confirmation provider {} is corrupt ({}); treating the unreadable period as spent until it rolls over",
                    providerId, value);
        }
        return true;
    }

    /** Reads {@code <day>:<units>|<month>:<units>}, blocking each period that is unreadable. False if any was. */
    private static boolean readStored(String value, Counter c, LocalDate today) {
        String[] parts = value.split("\\|", -1);
        boolean dayOk = parts.length == 2 && c.day.read(parts[0], LocalDate::parse);
        boolean monthOk = parts.length == 2 && c.month.read(parts[1], YearMonth::parse);
        if (!dayOk) c.day.block(today);
        if (!monthOk) c.month.block(YearMonth.from(today));
        return dayOk && monthOk;
    }

    private void persist(Counter c) {
        try {
            appState.put(KEY_PREFIX + c.providerId, c.day.stored() + "|" + c.month.stored());
        } catch (RuntimeException e) {
            log.warn("Could not store the budget of confirmation provider {}", c.providerId, e);
        }
    }
}
