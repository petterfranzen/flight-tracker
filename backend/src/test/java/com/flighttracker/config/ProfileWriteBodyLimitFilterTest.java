package com.flighttracker.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Finding M4 (section9-hq #403): the profile write surface may not carry an unbounded
 * request body. These drive {@link ProfileWriteBodyLimitFilter} directly with a chain
 * that reads the body the way a controller's {@code @RequestBody} would, so both the
 * declared-length fast path and the counting stream are exercised.
 */
class ProfileWriteBodyLimitFilterTest {

    private final ProfileWriteBodyLimitFilter filter = new ProfileWriteBodyLimitFilter();

    /** A chain that reads the whole body (like Jackson) and answers 200. */
    private static FilterChain readingChain(AtomicBoolean reached) {
        return (request, response) -> {
            reached.set(true);
            request.getInputStream().readAllBytes();
            ((HttpServletResponse) response).setStatus(200);
        };
    }

    private static MockHttpServletRequest write(String path, byte[] body) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", path);
        request.setContent(body);
        return request;
    }

    private static byte[] body(int bytes) {
        return new byte[bytes];
    }

    @Test
    void aDeclaredBodyOverTheCapIsRefusedWithoutReadingIt() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean();
        filter.doFilter(write("/api/profile", body((int) ProfileWriteBodyLimitFilter.MAX_BODY_BYTES + 1)),
                response, readingChain(reached));
        assertThat(response.getStatus()).isEqualTo(413);
        assertThat(response.getContentAsString()).contains("Payload Too Large");
        assertThat(reached).as("the body was refused before the chain ran").isFalse();
    }

    @Test
    void aBodyAtTheCapIsAccepted() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean();
        filter.doFilter(write("/api/profile", body((int) ProfileWriteBodyLimitFilter.MAX_BODY_BYTES)),
                response, readingChain(reached));
        assertThat(reached).isTrue();
        assertThat(response.getStatus()).isEqualTo(200);
    }

    @Test
    void aBodyWithNoDeclaredLengthIsRefusedOnceItPassesTheCap() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/profile") {
            @Override
            public long getContentLengthLong() {
                return -1;
            }
        };
        request.setContent(body((int) ProfileWriteBodyLimitFilter.MAX_BODY_BYTES + 1));
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, readingChain(new AtomicBoolean()));
        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void aSafeMethodIsNeverCapped() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/profile");
        request.setContent(body((int) ProfileWriteBodyLimitFilter.MAX_BODY_BYTES + 1));
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean();
        filter.doFilter(request, response, readingChain(reached));
        assertThat(reached).isTrue();
        assertThat(response.getStatus()).isEqualTo(200);
    }

    @Test
    void aWriteOutsideTheFeatureSurfaceIsNeverCapped() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean();
        filter.doFilter(write("/api/health", body((int) ProfileWriteBodyLimitFilter.MAX_BODY_BYTES + 1)),
                response, readingChain(reached));
        assertThat(reached).isTrue();
        assertThat(response.getStatus()).isEqualTo(200);
    }

    @Test
    void theSignOutPostIsCappedToo() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(write("/api/auth/logout", body((int) ProfileWriteBodyLimitFilter.MAX_BODY_BYTES + 1)),
                response, readingChain(new AtomicBoolean()));
        assertThat(response.getStatus()).isEqualTo(413);
    }
}
