package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

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

    @Test
    void withoutProviderKeys_theGlobalDailyBudgetApplies_andMonthlyIsUnlimited() {
        ConfirmationBudgets b = budgets(3);

        assertThat(b.tryCharge("p", 1)).isTrue();
        assertThat(b.tryCharge("p", 2)).isTrue();
        assertThat(b.tryCharge("p", 1)).isFalse();
        assertThat(b.unitsToday("p")).isEqualTo(3);
        assertThat(b.unitsThisMonth("p")).isEqualTo(3);
    }

    @Test
    void theDailyBudgetIsInUnits_aCostlyCallThatDoesNotFitIsRefusedWholeAndNotCharged() {
        env.setProperty("flighttracker.confirmation.providers.adb.daily-budget", "5");
        ConfirmationBudgets b = budgets(300);

        assertThat(b.tryCharge("adb", 2)).isTrue();
        assertThat(b.tryCharge("adb", 2)).isTrue();
        assertThat(b.tryCharge("adb", 2)).isFalse(); // 4 + 2 > 5
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
        assertThat(b.tryCharge("adb", 5)).isFalse();
        assertThat(b.tryCharge("adb", 4)).isTrue();
        assertThat(b.unitsThisMonth("adb")).isEqualTo(10);
    }

    @Test
    void theDailyBudgetResetsAtUtcMidnight_notTheMonthlyOne() {
        env.setProperty("flighttracker.confirmation.providers.p.daily-budget", "2");
        env.setProperty("flighttracker.confirmation.providers.p.monthly-budget", "100");
        ConfirmationBudgets b = budgets(300);
        clock.set(Instant.parse("2026-10-12T23:59:00Z"));
        b.tryCharge("p", 2);
        assertThat(b.tryCharge("p", 1)).isFalse();

        clock.set(Instant.parse("2026-10-13T00:00:00Z"));

        assertThat(b.tryCharge("p", 1)).isTrue();
        assertThat(b.unitsToday("p")).isEqualTo(1);
        assertThat(b.unitsThisMonth("p")).isEqualTo(3);
    }

    @Test
    void theMonthlyBudgetResetsOnThe1stUtc() {
        env.setProperty("flighttracker.confirmation.providers.p.monthly-budget", "4");
        ConfirmationBudgets b = budgets(300);
        clock.set(Instant.parse("2026-10-31T23:59:00Z"));
        b.tryCharge("p", 4);
        assertThat(b.tryCharge("p", 1)).isFalse();

        clock.set(Instant.parse("2026-11-01T00:00:00Z"));

        assertThat(b.tryCharge("p", 4)).isTrue();
        assertThat(b.unitsThisMonth("p")).isEqualTo(4);
        assertThat(b.unitsToday("p")).isEqualTo(4);
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

        assertThat(after.unitsToday("adb")).isEqualTo(4);
        assertThat(after.unitsThisMonth("adb")).isEqualTo(4);
        assertThat(after.tryCharge("adb", 5)).isFalse(); // 4 + 5 > 8 today
        assertThat(after.tryCharge("adb", 4)).isTrue();
    }

    @Test
    void aStoredCounterFromEarlierDaysAndMonths_isRolledOverOnLoad() {
        appState.put("confirmation.budget.p", "2026-09-30:7|2026-09:90");
        env.setProperty("flighttracker.confirmation.providers.p.monthly-budget", "100");

        ConfirmationBudgets b = budgets(300);

        assertThat(b.unitsToday("p")).isZero();
        assertThat(b.unitsThisMonth("p")).isZero();

        appState.put("confirmation.budget.q", "2026-10-11:7|2026-10:90");
        env.setProperty("flighttracker.confirmation.providers.q.monthly-budget", "100");
        assertThat(b.unitsToday("q")).isZero();
        assertThat(b.unitsThisMonth("q")).isEqualTo(90);
    }

    @Test
    void anUnreadableStoredValue_startsFromZero_insteadOfFailing() {
        appState.put("confirmation.budget.p", "garbage");

        assertThat(budgets(300).tryCharge("p", 1)).isTrue();
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
