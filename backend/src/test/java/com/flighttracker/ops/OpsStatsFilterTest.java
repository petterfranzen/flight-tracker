package com.flighttracker.ops;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class OpsStatsFilterTest {

    private static final JsonMapper MAPPER = new JsonMapper();

    private final AccessTokenVerifier verifier = mock(AccessTokenVerifier.class);
    private final OpsStatsReader reader = mock(OpsStatsReader.class);
    private final OpsStatsFilter filter = new OpsStatsFilter(verifier, reader, MAPPER);

    private static OpsStats sample() {
        return new OpsStats(Instant.parse("2026-10-26T08:00:00Z"), 3600L,
                new OpsStats.Memory(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L, 9L, 0L, 0.1, 0.2, 0.3, 0.4, 10L, 11L, 12L, 13L),
                new OpsStats.Io(14L, 15L), new OpsStats.Cpu(16.5, 0.7), new OpsStats.Data(17L),
                new OpsStats.Freshness(Instant.parse("2026-10-26T07:58:00Z"), 18L));
    }

    private MockHttpServletRequest get(String path, String token) {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", path);
        if (token != null) req.addHeader(OpsStatsFilter.ACCESS_TOKEN_HEADER, token);
        return req;
    }

    @Test
    void withoutAValidTokenTheRequestFallsThroughUntouched() throws Exception {
        when(verifier.verify(any())).thenReturn(false);
        for (String token : new String[] {null, "forged"}) {
            MockHttpServletResponse res = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();
            filter.doFilter(get(OpsStatsFilter.PATH, token), res, chain);

            assertThat(chain.getRequest()).as("passed on to the normal (SPA fallback) handling").isNotNull();
            assertThat(res.getContentAsString()).isEmpty();
            assertThat(res.getHeader("Cache-Control")).isNull();
        }
        verify(reader, never()).read();
    }

    @Test
    void withAValidTokenItServesTheStats() throws Exception {
        when(verifier.verify("good")).thenReturn(true);
        when(reader.read()).thenReturn(sample());
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(get(OpsStatsFilter.PATH, "good"), res, chain);

        assertThat(chain.getRequest()).as("not passed on").isNull();
        assertThat(res.getStatus()).isEqualTo(200);
        assertThat(res.getContentType()).startsWith("application/json");
        assertThat(res.getHeader("Cache-Control")).isEqualTo("no-store");
        JsonNode body = MAPPER.readTree(res.getContentAsString());
        assertThat(body.path("memory").path("appBytes").asLong()).isEqualTo(4L);
        assertThat(body.path("freshness").path("aircraftSeenLast10m").asLong()).isEqualTo(18L);
    }

    @Test
    void otherMethodsAndPathsAreNeverServed() throws Exception {
        when(verifier.verify(any())).thenReturn(true);
        MockHttpServletRequest post = new MockHttpServletRequest("POST", OpsStatsFilter.PATH);
        post.addHeader(OpsStatsFilter.ACCESS_TOKEN_HEADER, "good");
        for (MockHttpServletRequest req : List.of(post, get(OpsStatsFilter.PATH + "/", "good"), get("/api/health", "good"))) {
            MockFilterChain chain = new MockFilterChain();
            filter.doFilter(req, new MockHttpServletResponse(), chain);
            assertThat(chain.getRequest()).isNotNull();
        }
        verify(reader, never()).read();
    }

    /** The owner's rule: nothing in the response may hint at the stack behind it. */
    @Test
    void responseNamesNothingAboutTheStack() throws Exception {
        when(verifier.verify("good")).thenReturn(true);
        when(reader.read()).thenReturn(sample());
        MockHttpServletResponse res = new MockHttpServletResponse();
        filter.doFilter(get(OpsStatsFilter.PATH, "good"), res, new MockFilterChain());

        List<String> names = new ArrayList<>();
        collectFieldNames(MAPPER.readTree(res.getContentAsString()), names);
        String joined = String.join(" ", names).toLowerCase(Locale.ROOT);
        for (String word : List.of("jvm", "java", "heap", "gc", "sqlite", "spring", "tomcat", "cgroup", "linux",
                "proc", "systemd", "opensky", "hikari", "jackson", "version", "path", "host")) {
            assertThat(joined).as("field names mention '%s'", word).doesNotContain(word);
        }
        for (String header : res.getHeaderNames()) {
            assertThat(header.toLowerCase(Locale.ROOT)).isIn("content-type", "cache-control", "content-length");
        }
    }

    private static void collectFieldNames(JsonNode node, List<String> out) {
        for (var entry : node.properties()) {
            out.add(entry.getKey());
            collectFieldNames(entry.getValue(), out);
        }
    }
}
