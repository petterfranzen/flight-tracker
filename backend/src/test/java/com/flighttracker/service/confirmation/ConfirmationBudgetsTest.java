package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/** Daily and monthly budgets in units, the UTC resets, the 80% warning and the app_state write-through. */
class ConfirmationBudgetsTest {

    private TestClock clock;
    private InMemoryAppState appState;
    private MockEnvironment env;
    private PhaseLogger phaseLogger;

    @BeforeEach
    void setUp() {
        clock = new TestClock();
        clock.set(Instant.parse("2026-10-12T10:00:00Z"));
        appState = new InMemoryAppState(clock);
        env = new MockEnvironment();
        phaseLogger = new PhaseLogger();
    }

    private ConfirmationBudgets budgets(int globalDaily) {
        return new ConfirmationBudgets(appState, clock, env, phaseLogger, globalDaily);
    }

    /** tryCharge for each of {@code units} in turn; what each one answered. */
    private static List<Boolean> charges(ConfirmationBudgets b, String providerId, int... units) {
        List<Boolean> answers = new ArrayList<>();
        for (int u : units) answers.add(b.tryCharge(providerId, u));
        return answers;
    }

    /** Units charged today and this month, in that order. */
    private static List<Integer> units(ConfirmationBudgets b, String providerId) {
        return List.of(b.unitsToday(providerId), b.unitsThisMonth(providerId));
    }

    private void setBudget(String providerId, String period, int units) {
        env.setProperty("flighttracker.confirmation.providers." + providerId + "." + period + "-budget", String.valueOf(units));
    }

    @Test
    void withoutProviderKeys_theGlobalDailyBudgetApplies_andMonthlyIsUnlimited() {
        ConfirmationBudgets b = budgets(3);

        assertThat(charges(b, "p", 1, 2, 1)).containsExactly(true, true, false);
        assertThat(units(b, "p")).containsExactly(3, 3);
    }

    @Test
    void theDailyBudgetIsInUnits_aCostlyCallThatDoesNotFitIsRefusedWholeAndNotCharged() {
        env.setProperty("flighttracker.confirmation.providers.adb.daily-budget", "5");
        ConfirmationBudgets b = budgets(300);

        assertThat(charges(b, "adb", 2, 2, 2)).containsExactly(true, true, false); // 4 + 2 > 5
        assertThat(b.unitsToday("adb")).isEqualTo(4);
        assertThat(b.tryCharge("adb", 1)).isTrue();
    }

    @Test
    void aProviderKeyOverridesTheGlobalDefault_andOtherProvidersKeepTheDefault() {
        env.setProperty("flighttracker.confirmation.providers.big.daily-budget", "100");
        ConfirmationBudgets b = budgets(1);

        assertThat(b.tryCharge("big", 50)).isTrue();
        assertThat(b.tryCharge("small", 1)).isTrue();
        assertThat(b.tryCharge("small", 1)).isFalse();
    }

    @Test
    void theMonthlyBudgetStopsCalls_evenWhenTheDailyOneHasRoom() {
        env.setProperty("flighttracker.confirmation.providers.adb.monthly-budget", "10");
        ConfirmationBudgets b = budgets(300);

        assertThat(b.tryCharge("adb", 6)).isTrue();
        clock.set(Instant.parse("2026-10-20T10:00:00Z")); // another day, same month
        assertThat(b.unitsToday("adb")).isZero();
        assertThat(charges(b, "adb", 5, 4)).containsExactly(false, true);
        assertThat(b.unitsThisMonth("adb")).isEqualTo(10);
    }

    @Test
    void theDailyBudgetResetsAtUtcMidnight_notTheMonthlyOne() {
        setBudget("p", "daily", 2);
        setBudget("p", "monthly", 100);
        ConfirmationBudgets b = budgets(300);
        clock.set(Instant.parse("2026-10-12T23:59:00Z"));
        assertThat(charges(b, "p", 2, 1)).endsWith(false);

        clock.set(Instant.parse("2026-10-13T00:00:00Z"));

        assertThat(b.tryCharge("p", 1)).isTrue();
        assertThat(units(b, "p")).containsExactly(1, 3);
    }

    @Test
    void theMonthlyBudgetResetsOnThe1stUtc() {
        setBudget("p", "monthly", 4);
        ConfirmationBudgets b = budgets(300);
        clock.set(Instant.parse("2026-10-31T23:59:00Z"));
        assertThat(charges(b, "p", 4, 1)).endsWith(false);

        clock.set(Instant.parse("2026-11-01T00:00:00Z"));

        assertThat(b.tryCharge("p", 4)).isTrue();
        assertThat(units(b, "p")).containsExactly(4, 4);
    }

    @Test
    void adjust_correctsTheChargeInBothDirections_andNeverGoesBelowZero() {
        ConfirmationBudgets b = budgets(300);
        b.tryCharge("p", 1);

        b.adjust("p", 2);
        assertThat(b.unitsToday("p")).isEqualTo(3);
        b.adjust("p", -3);
        assertThat(b.unitsToday("p")).isZero();
        b.adjust("p", -1);
        assertThat(b.unitsToday("p")).isZero();
    }

    @Test
    void everyChargeIsWrittenThrough_andANewInstanceContinuesFromIt() {
        env.setProperty("flighttracker.confirmation.providers.adb.monthly-budget", "10");
        env.setProperty("flighttracker.confirmation.providers.adb.daily-budget", "8");
        ConfirmationBudgets before = budgets(300);
        before.tryCharge("adb", 2);
        before.tryCharge("adb", 2);
        assertThat(appState.rows).containsEntry("confirmation.budget.adb", "2026-10-12:4|2026-10:4");

        ConfirmationBudgets after = budgets(300); // a restart: new instance, same app_state

        assertThat(units(after, "adb")).containsExactly(4, 4);
        assertThat(charges(after, "adb", 5, 4)).containsExactly(false, true); // 4 + 5 > 8 today
    }

    @Test
    void aStoredCounterFromEarlierDaysAndMonths_isRolledOverOnLoad() {
        appState.put("confirmation.budget.p", "2026-09-30:7|2026-09:90");
        env.setProperty("flighttracker.confirmation.providers.p.monthly-budget", "100");

        ConfirmationBudgets b = budgets(300);

        assertThat(units(b, "p")).containsExactly(0, 0);

        appState.put("confirmation.budget.q", "2026-10-11:7|2026-10:90");
        env.setProperty("flighttracker.confirmation.providers.q.monthly-budget", "100");
        assertThat(units(b, "q")).containsExactly(0, 90);
    }

    @Test
    void aValueWithoutTheSeparator_failsClosedForTheDayAndTheMonth() {
        appState.put("confirmation.budget.p", "garbage");
        env.setProperty("flighttracker.confirmation.providers.p.monthly-budget", "100");
        ConfirmationBudgets b = budgets(300);

        assertThat(b.tryCharge("p", 1)).isFalse();

        clock.set(Instant.parse("2026-10-13T00:00:01Z")); // the day rolls over, the month does not
        assertThat(b.tryCharge("p", 1)).isFalse();
        clock.set(Instant.parse("2026-11-01T00:00:01Z"));
        assertThat(b.tryCharge("p", 1)).isTrue();
        assertThat(appState.rows.get("confirmation.budget.p")).isEqualTo("2026-11-01:1|2026-11:1");
    }

    @Test
    void aCorruptMonthPart_blocksTheMonthUntilItRollsOver() {
        appState.put("confirmation.budget.p", "2026-10-12:5|garbage");
        ConfirmationBudgets b = budgets(300);

        assertThat(b.tryCharge("p", 1)).isFalse();
        assertThat(b.unitsToday("p")).isEqualTo(5); // the readable part is kept
        clock.set(Instant.parse("2026-11-01T00:00:01Z"));
        assertThat(b.tryCharge("p", 1)).isTrue();
    }

    @Test
    void aNegativeStoredCount_isNeverParsedAsCredit_andBlocksThatPeriod() {
        appState.put("confirmation.budget.p", "2026-10-12:-5|2026-10:3");
        ConfirmationBudgets b = budgets(300);

        assertThat(b.tryCharge("p", 1)).isFalse();
        assertThat(b.unitsToday("p")).isZero(); // not -5
        assertThat(b.unitsThisMonth("p")).isEqualTo(3);
        clock.set(Instant.parse("2026-10-13T00:00:01Z"));
        assertThat(b.tryCharge("p", 1)).isTrue();

        appState.put("confirmation.budget.q", "2026-10-13:1|2026-10:-5");
        assertThat(b.tryCharge("q", 1)).isFalse();
        assertThat(b.unitsThisMonth("q")).isZero();
    }

    @Test
    void aFailedFirstRead_deniesTheChargeAndIsRetriedNextTime_withoutOverwritingTheStoredCount() {
        env.setProperty("flighttracker.confirmation.providers.p.monthly-budget", "10");
        AtomicInteger reads = new AtomicInteger();
        InMemoryAppState flaky = new InMemoryAppState(clock) {
            @Override
            public Optional<String> get(String key) {
                if (reads.getAndIncrement() == 0) throw new IllegalStateException("database is locked");
                return super.get(key);
            }
        };
        flaky.rows.put("confirmation.budget.p", "2026-10-12:4|2026-10:9");
        ConfirmationBudgets b = new ConfirmationBudgets(flaky, clock, env, phaseLogger, 300);

        assertThat(b.tryCharge("p", 1)).isFalse(); // fail closed
        assertThat(flaky.rows).containsEntry("confirmation.budget.p", "2026-10-12:4|2026-10:9"); // not overwritten

        assertThat(b.tryCharge("p", 1)).isTrue(); // the retry reads the real count: 9 + 1 <= 10
        assertThat(b.unitsThisMonth("p")).isEqualTo(10);
        assertThat(charges(b, "p", 1)).containsExactly(false);
    }

    @Test
    void anExhaustedDailyBudget_logsOneDegradedLinePerProviderAndDay() {
        setBudget("p", "daily", 2);
        PhaseLogger logger = mock(PhaseLogger.class);
        ConfirmationBudgets b = new ConfirmationBudgets(appState, clock, env, logger, 300);

        b.tryCharge("p", 2);
        verify(logger, never()).degraded(anyString());
        assertThat(charges(b, "p", 1, 1, 1)).containsOnly(false);
        verify(logger, times(1)).degraded(contains("daily budget"));

        clock.set(Instant.parse("2026-10-13T00:00:01Z"));
        assertThat(charges(b, "p", 2, 1)).endsWith(false);
        verify(logger, times(2)).degraded(contains("daily budget")); // once more on the new day
    }

    @Test
    void anExhaustedMonthlyBudget_logsOneDegradedLinePerProviderAndMonth() {
        setBudget("p", "monthly", 3);
        PhaseLogger logger = mock(PhaseLogger.class);
        ConfirmationBudgets b = new ConfirmationBudgets(appState, clock, env, logger, 300);

        b.tryCharge("p", 3);
        for (String day : List.of("2026-10-20T10:00:00Z", "2026-10-21T10:00:00Z")) {
            clock.set(Instant.parse(day));
            assertThat(b.tryCharge("p", 1)).isFalse();
        }
        verify(logger, times(1)).degraded(contains("monthly budget of"));

        clock.set(Instant.parse("2026-11-02T10:00:00Z"));
        assertThat(charges(b, "p", 3, 1)).endsWith(false);
        verify(logger, times(2)).degraded(contains("monthly budget of"));
    }

    @Test
    void at80PercentOfTheMonthlyBudget_degradedIsLoggedOnce_perMonth() {
        env.setProperty("flighttracker.confirmation.providers.adb.monthly-budget", "10");
        ConfirmationBudgets b = budgets(300);
        b.tryCharge("adb", 7);
        assertThat(phaseLogger.currentPhase()).isEqualTo(PhaseLogger.STARTING_UP);

        b.tryCharge("adb", 1); // 8 of 10
        assertThat(phaseLogger.currentPhase()).isEqualTo(PhaseLogger.DEGRADED);

        phaseLogger.ready("recovered");
        b.tryCharge("adb", 1); // 9 of 10: no second warning
        assertThat(phaseLogger.currentPhase()).isEqualTo(PhaseLogger.READY);

        clock.advance(Duration.ofDays(20)); // November
        b.tryCharge("adb", 8);
        assertThat(phaseLogger.currentPhase()).isEqualTo(PhaseLogger.DEGRADED);
    }

    @Test
    void withoutAMonthlyBudget_thereIsNothingToWarnAbout() {
        ConfirmationBudgets b = budgets(300);
        b.tryCharge("p", 200);

        assertThat(phaseLogger.currentPhase()).isEqualTo(PhaseLogger.STARTING_UP);
    }
}
