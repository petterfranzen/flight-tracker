package com.flighttracker.config;

import org.apache.catalina.core.StandardHost;
import org.apache.catalina.startup.Tomcat;
import org.springframework.boot.tomcat.TomcatWebServer;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Replaces Tomcat's default error-report page (see {@link QuietErrorReportValve}).
 *
 * <p>Spring Boot exposes no property for the host's {@code errorReportValveClass},
 * and neither a context nor an engine customizer can reach the host, so this
 * defines the web-server factory itself and sets the class on the host right
 * before Boot starts Tomcat. Defining the factory is safe: Boot's own is
 * {@code @ConditionalOnMissingBean}, and every {@code WebServerFactoryCustomizer}
 * (port, address, graceful shutdown) still applies to this bean, so
 * {@code server.*} keeps working.
 */
@Configuration
public class TomcatErrorPageConfig {

    @Bean
    public TomcatServletWebServerFactory tomcatServletWebServerFactory() {
        return new TomcatServletWebServerFactory() {
            @Override
            protected TomcatWebServer getTomcatWebServer(Tomcat tomcat) {
                if (tomcat.getHost() instanceof StandardHost host) {
                    host.setErrorReportValveClass(QuietErrorReportValve.class.getName());
                }
                return super.getTomcatWebServer(tomcat);
            }
        };
    }
}
