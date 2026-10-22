package com.flighttracker.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.beans.factory.support.AbstractBeanDefinition;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.util.ClassUtils;

import java.io.IOException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Every @Scheduled method in the process shares one pool (see the comment on
 * spring.task.scheduling.pool.size in application.yml), so a new one must
 * come with a bigger pool: one thread per method, plus one spare.
 */
class SchedulerPoolSizeTest {

    @Test
    void poolHasOneThreadPerScheduledMethodPlusOneSpare() throws Exception {
        List<String> scheduled = scheduledMethods();
        assertThat(scheduled).as("@Scheduled methods found").isNotEmpty();

        assertThat(poolSize()).as("spring.task.scheduling.pool.size for %s", scheduled)
                .isEqualTo(scheduled.size() + 1);
    }

    private static int poolSize() throws IOException {
        for (PropertySource<?> ps : new YamlPropertySourceLoader().load("application", new ClassPathResource("application.yml"))) {
            Object v = ps.getProperty("spring.task.scheduling.pool.size");
            if (v != null) return Integer.parseInt(v.toString());
        }
        throw new IllegalStateException("spring.task.scheduling.pool.size is not set in application.yml");
    }

    private static List<String> scheduledMethods() throws Exception {
        ClassPathScanningCandidateComponentProvider scanner = new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(Component.class));
        List<String> out = new ArrayList<>();
        for (BeanDefinition bd : scanner.findCandidateComponents("com.flighttracker")) {
            // only the application's classes, not test fixtures
            if (bd instanceof AbstractBeanDefinition abd && abd.getResource() != null
                    && abd.getResource().getURL().toString().contains("test-classes")) continue;
            Class<?> type = ClassUtils.forName(bd.getBeanClassName(), SchedulerPoolSizeTest.class.getClassLoader());
            for (Method m : type.getDeclaredMethods()) {
                int n = AnnotatedElementUtils.getMergedRepeatableAnnotations(m, Scheduled.class).size();
                for (int i = 0; i < n; i++) out.add(type.getSimpleName() + "." + m.getName());
            }
        }
        return out;
    }
}
