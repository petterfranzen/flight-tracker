package com.flighttracker.config;

import org.apache.catalina.connector.Connector;
import org.apache.catalina.core.StandardHost;
import org.apache.coyote.http11.AbstractHttp11Protocol;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.tomcat.TomcatWebServer;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.error.ErrorPage;
import org.springframework.boot.web.server.Shutdown;
import org.springframework.boot.web.server.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pins the one structural risk of the generic error bodies (#156):
 * {@link TomcatErrorPageConfig} defines its own
 * {@code TomcatServletWebServerFactory} bean, and Boot's own is
 * {@code @ConditionalOnMissingBean} - so if a future change makes that bean
 * stop going through the {@code WebServerFactoryCustomizer} post-processor,
 * {@code server.port}, {@code server.address}, {@code server.shutdown} and
 * {@code spring.web.error.path} would silently stop reaching Tomcat. Defining the
 * factory is safe only because every customizer still applies to it; this test
 * holds that contract.
 *
 * <p>A properties-driven context on a fixed free port, so each value asserted
 * here differs from the factory's own default: {@code address} is null until
 * the customizer sets it, graceful-shutdown mode is {@code IMMEDIATE} until the
 * customizer flips it, {@code port} defaults to 8080, and the error page path
 * defaults to {@code /error}. Any of those coming back as the default is
 * exactly the regression.
 *
 * <p>The app under test is minimal ({@link MinimalApp}) - this is about the
 * web server layer, not the flight-tracker beans - with the JDBC
 * auto-configuration off so a missing DataSource cannot fail the context.
 */
@SpringBootTest(
        classes = TomcatErrorPageConfigTest.MinimalApp.class,
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = "spring.main.banner-mode=off")
class TomcatErrorPageConfigTest {

    /** A free port picked just before the context starts; the customizer must transfer it to the factory. */
    private static final int PORT = freePort();
    private static final String ERROR_PATH = "/not-a-framework-page";

    private static int freePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (Exception ex) {
            throw new IllegalStateException("could not reserve a free port", ex);
        }
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @Import(TomcatErrorPageConfig.class)
    static class MinimalApp {
    }

    @DynamicPropertySource
    static void serverProperties(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> PORT);
        registry.add("server.address", () -> "127.0.0.1");
        registry.add("server.shutdown", () -> "graceful");
        registry.add("spring.web.error.path", () -> ERROR_PATH);
    }

    @Autowired
    private ApplicationContext context;

    @Test
    void serverPropertiesReachTheCustomFactoryBean() throws Exception {
        TomcatServletWebServerFactory factory = context.getBean(TomcatServletWebServerFactory.class);

        assertThat(factory.getClass().getName())
                .as("the config's own factory bean must be the one left in place (Boot's is @ConditionalOnMissingBean)")
                .contains("TomcatErrorPageConfig");

        // server.port -> ConfigurableWebServerFactory.setPort
        assertThat(factory.getPort()).isEqualTo(PORT);
        // server.address -> setAddress (null until the customizer runs)
        assertThat(factory.getAddress()).isEqualTo(InetAddress.getByName("127.0.0.1"));
        // server.shutdown -> setShutdown (IMMEDIATE until the customizer runs)
        assertThat(factory.getShutdown()).isEqualTo(Shutdown.GRACEFUL);
        // the error page path (spring.web.error.path in Boot 4) -> an ErrorPage on the factory
        assertThat(factory.getErrorPages()).extracting(ErrorPage::getPath).contains(ERROR_PATH);
    }

    @Test
    void theRunningServerUsesThatFactory() {
        ServletWebServerApplicationContext webContext = (ServletWebServerApplicationContext) context;
        TomcatWebServer server = (TomcatWebServer) webContext.getWebServer();

        assertThat(server.getPort()).isEqualTo(PORT);
        // The config's actual purpose still holds on the server it builds: our valve replaces the
        // container's own error-report page.
        assertThat(server.getTomcat().getHost()).isInstanceOf(StandardHost.class);
        assertThat(((StandardHost) server.getTomcat().getHost()).getErrorReportValveClass())
                .isEqualTo(QuietErrorReportValve.class.getName());
    }

    @Test
    void theConfiguredErrorPathIsServedByTheContainer() throws Exception {
        // A direct GET of the error page path is answered (500) only if the error page path really
        // reached Tomcat's error-page registration; otherwise the path is unmapped.
        HttpClient client = HttpClient.newHttpClient();
        HttpResponse<Void> response = client.send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + PORT + ERROR_PATH)).GET().build(),
                HttpResponse.BodyHandlers.discarding());

        assertThat(response.statusCode()).isEqualTo(500);
    }

    /**
     * Response compression. Nothing in this backend sets {@code server.compression.*}
     * (application.yml and TomcatErrorPageConfig leave it alone), so Boot's default
     * applies: compression off. This documents that default on the live connector, and
     * fails if a setting or a customizer ever turns it on without this test being updated
     * on purpose.
     */
    @Test
    void responseCompressionIsOff_theBootDefault_becauseNothingSetsIt() {
        ServletWebServerApplicationContext webContext = (ServletWebServerApplicationContext) context;
        TomcatWebServer server = (TomcatWebServer) webContext.getWebServer();
        Connector connector = server.getTomcat().getConnector();

        assertThat(connector.getProtocolHandler()).isInstanceOf(AbstractHttp11Protocol.class);
        AbstractHttp11Protocol<?> protocol = (AbstractHttp11Protocol<?>) connector.getProtocolHandler();
        assertThat(protocol.getCompression()).isEqualTo("off");
        assertThat(context.getEnvironment().getProperty("server.compression.enabled"))
                .as("no server.compression.enabled is configured anywhere").isNull();
    }

    @Test
    void anErrorBodyIsNotCompressedEvenWhenTheClientAsksForGzip() throws Exception {
        HttpResponse<byte[]> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + PORT + ERROR_PATH))
                        .header("Accept-Encoding", "gzip")
                        .GET().build(),
                HttpResponse.BodyHandlers.ofByteArray());

        assertThat(response.statusCode()).isEqualTo(500);
        assertThat(response.headers().firstValue("Content-Encoding")).isEmpty();
    }
}
