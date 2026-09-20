package com.flighttracker.observability;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The phase marker is a wire format docker-monitor parses, so what matters
 * here is the exact text and how often it appears — not that the method
 * was called.
 */
class PhaseLoggerTest {

    /** Must stay in step with docker-monitor's own parser (phases.py). */
    private static final Pattern MARKER = Pattern.compile("\\[phase:([a-z_]+)\\]\\s*(.*)");

    private ListAppender<ILoggingEvent> appender;
    private ch.qos.logback.classic.Logger logger;

    @BeforeEach
    void attachAppender() {
        logger = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(PhaseLogger.class);
        appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.INFO);
    }

    @AfterEach
    void detachAppender() {
        logger.detachAppender(appender);
    }

    private List<String> messages() {
        return appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    @Test
    void emitsAParseableMarkerWithDetail() {
        new PhaseLogger().populating("global sweep 1/3");

        String populating = messages().stream()
                .filter(m -> m.contains("populating_data"))
                .findFirst()
                .orElseThrow();

        var matcher = MARKER.matcher(populating);
        assertThat(matcher.matches()).isTrue();
        assertThat(matcher.group(1)).isEqualTo("populating_data");
        assertThat(matcher.group(2)).isEqualTo("global sweep 1/3");
    }

    @Test
    void announcesStartingUpOnConstruction() {
        new PhaseLogger();
        assertThat(messages()).anyMatch(m -> m.startsWith("[phase:starting_up]"));
    }

    @Test
    void repeatedCallsInTheSamePhaseEmitOnce() {
        // The reason this class enforces transition-only rather than
        // trusting call sites: the natural place to call populating() is
        // inside a loop that runs every few seconds.
        PhaseLogger phases = new PhaseLogger();
        appender.list.clear();

        for (int i = 0; i < 100; i++) {
            phases.populating("refreshing estimated positions");
        }

        assertThat(messages()).hasSize(1);
    }

    @Test
    void changingDetailWithinTheSamePhaseDoesNotReEmit() {
        PhaseLogger phases = new PhaseLogger();
        appender.list.clear();

        phases.populating("sweep 1/3");
        phases.populating("sweep 2/3");
        phases.populating("sweep 3/3");

        assertThat(messages()).hasSize(1);
        assertThat(messages().get(0)).endsWith("sweep 1/3");
    }

    @Test
    void movingBetweenPhasesEmitsEachTransition() {
        PhaseLogger phases = new PhaseLogger();
        appender.list.clear();

        phases.populating("sweep");
        phases.idle("done");
        phases.populating("sweep");

        assertThat(messages()).containsExactly(
                "[phase:populating_data] sweep",
                "[phase:idle] done",
                "[phase:populating_data] sweep");
    }

    @Test
    void tracksTheCurrentPhase() {
        PhaseLogger phases = new PhaseLogger();
        assertThat(phases.currentPhase()).isEqualTo(PhaseLogger.STARTING_UP);
        phases.degraded("OpenSky 429");
        assertThat(phases.currentPhase()).isEqualTo(PhaseLogger.DEGRADED);
    }

    @Test
    void emitsABareMarkerWhenThereIsNoDetail() {
        PhaseLogger phases = new PhaseLogger();
        appender.list.clear();
        phases.ready("");

        assertThat(messages()).containsExactly("[phase:ready]");
        assertThat(MARKER.matcher("[phase:ready]").matches()).isTrue();
    }
}
