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
        Integer dailyLimit;
        Integer monthlyLimit;
        LocalDate day;
        int dayUnits;
        YearMonth month;
        int monthUnits;
        boolean warned;
        /** The stored day (or month) could not be read: treated as spent until it rolls over. */
        boolean dayBlocked;
        boolean monthBlocked;
        LocalDate exhaustedLoggedOn;
        YearMonth monthExhaustedLoggedIn;
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
        if (c.dayBlocked || (c.dailyLimit != null && c.dayUnits + units > c.dailyLimit)) {
            if (!c.day.equals(c.exhaustedLoggedOn)) {
                c.exhaustedLoggedOn = c.day;
                exhausted(providerId, c.dayBlocked
                        ? "its stored daily count is unreadable, so it is treated as spent until 00:00 UTC"
                        : "its daily budget of " + c.dailyLimit + " units is spent, no more calls until 00:00 UTC");
            }
            return false;
        }
        if (c.monthBlocked || (c.monthlyLimit != null && c.monthUnits + units > c.monthlyLimit)) {
            if (!c.month.equals(c.monthExhaustedLoggedIn)) {
                c.monthExhaustedLoggedIn = c.month;
                exhausted(providerId, c.monthBlocked
                        ? "its stored monthly count is unreadable, so it is treated as spent until the 1st (UTC)"
                        : "its monthly budget of " + c.monthlyLimit + " units is spent, no more calls until the 1st (UTC)");
            }
            return false;
        }
        add(providerId, c, units);
        return true;
    }

    private void exhausted(String providerId, String why) {
        String detail = "Arrival provider " + providerId + " is out of budget: " + why;
        log.warn(detail); // PhaseLogger prints on a phase change only; this line is always there
        phaseLogger.degraded(detail);
    }

    /** Corrects an earlier charge once the real cost is known (negative refunds). May overshoot a limit. */
    public synchronized void adjust(String providerId, int deltaUnits) {
        if (deltaUnits == 0) return;
        Counter c = counter(providerId);
        if (c == null) return;
        add(providerId, c, deltaUnits);
    }

    public synchronized int unitsToday(String providerId) {
        Counter c = counter(providerId);
        return c == null ? 0 : c.dayUnits;
    }

    public synchronized int unitsThisMonth(String providerId) {
        Counter c = counter(providerId);
        return c == null ? 0 : c.monthUnits;
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

    /**
     * The provider's counter, loaded on first use and rolled over to the current UTC day and month.
     * Null when the stored count could not be read: nothing is cached then, so the next use retries
     * the read instead of starting from zero and overwriting the real count.
     */
    private Counter counter(String providerId) {
        LocalDate today = clock.instant().atZone(ZoneOffset.UTC).toLocalDate();
        Counter c = counters.get(providerId);
        if (c == null) {
            c = new Counter();
            String prefix = "flighttracker.confirmation.providers." + providerId + ".";
            c.dailyLimit = env.getProperty(prefix + "daily-budget", Integer.class, defaultDailyBudget);
            c.monthlyLimit = env.getProperty(prefix + "monthly-budget", Integer.class);
            if (!load(providerId, c, today)) return null;
            counters.put(providerId, c);
        }
        if (!today.equals(c.day)) {
            c.day = today;
            c.dayUnits = 0;
            c.dayBlocked = false;
        }
        YearMonth thisMonth = YearMonth.from(today);
        if (!thisMonth.equals(c.month)) {
            c.month = thisMonth;
            c.monthUnits = 0;
            c.monthBlocked = false;
            c.warned = false;
        }
        return c;
    }

    /**
     * Reads the stored count into {@code c}. False when app_state could not be read (nothing is
     * cached; fail closed). A value that is there but corrupt or negative blocks the affected period
     * until it rolls over, and is logged once (a loaded counter is cached).
     */
    private boolean load(String providerId, Counter c, LocalDate today) {
        String value;
        try {
            value = appState.get(KEY_PREFIX + providerId).orElse(null);
        } catch (RuntimeException e) {
            log.warn("Could not read the stored budget of confirmation provider {}; no calls until it can be read", providerId, e);
            return false;
        }
        if (value == null) return true;
        String[] parts = value.split("\\|", -1);
        boolean dayOk = parts.length == 2 && readDay(parts[0], c);
        boolean monthOk = parts.length == 2 && readMonth(parts[1], c);
        if (!dayOk) {
            c.day = today;
            c.dayUnits = 0;
            c.dayBlocked = true;
        }
        if (!monthOk) {
            c.month = YearMonth.from(today);
            c.monthUnits = 0;
            c.monthBlocked = true;
        }
        if (!dayOk || !monthOk) {
            log.warn("The stored budget of confirmation provider {} is corrupt ({}); treating the unreadable period as spent until it rolls over",
                    providerId, value);
        }
        return true;
    }

    private static boolean readDay(String part, Counter c) {
        try {
            String[] day = part.split(":", -1);
            if (day.length != 2) return false;
            LocalDate date = LocalDate.parse(day[0]);
            int units = Integer.parseInt(day[1]);
            if (units < 0) return false;
            c.day = date;
            c.dayUnits = units;
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static boolean readMonth(String part, Counter c) {
        try {
            String[] month = part.split(":", -1);
            if (month.length != 2) return false;
            YearMonth ym = YearMonth.parse(month[0]);
            int units = Integer.parseInt(month[1]);
            if (units < 0) return false;
            c.month = ym;
            c.monthUnits = units;
            return true;
        } catch (RuntimeException e) {
            return false;
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
