package com.flighttracker.profile;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The pepper is required exactly when the flag is on (finding M2, section9-hq
 * #405): with social login off there is no {@link SubjectHash} bean, so the
 * flag-off app starts with no pepper and is unchanged; with it on and no pepper
 * the context refuses to start rather than fall back to an unsalted hash.
 */
class SubjectHashWiringTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(Enable.class);

    @Configuration
    @Import(SubjectHash.class)
    static class Enable {
    }

    @Test
    void flagOff_noSubjectHashBean_andNoPepperNeeded() {
        runner.withPropertyValues("flighttracker.profile.enabled=false")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(SubjectHash.class));
    }

    @Test
    void flagOn_withAPepper_theBeanHashesDeterministically() {
        runner.withPropertyValues("flighttracker.profile.enabled=true",
                        "flighttracker.profile.subject-pepper=wiring-test-pepper-0123456789abcdef")
                .run(ctx -> assertThat(ctx.getBean(SubjectHash.class).of("github", "1"))
                        .isEqualTo(ctx.getBean(SubjectHash.class).of("github", "1")));
    }

    @Test
    void flagOn_withNoPepper_refusesToStart() {
        runner.withPropertyValues("flighttracker.profile.enabled=true")
                .run(ctx -> assertThat(ctx).hasFailed());
    }
}
