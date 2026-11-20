package com.flighttracker.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * A hard cap on the request body of the feature's own writes (finding M4 of the
 * 19 Nov security review, section9-hq #403).
 *
 * <p>Every route the app had before the profile feature answers a GET or a tiny
 * POST, so nothing bounded what a caller could send. The profile write API —
 * {@code PUT}/{@code DELETE} under {@code /api/profile} and
 * {@code POST /api/auth/logout} — is the first place a body is read into memory.
 * Spring MVC imposes no default limit on a JSON body (Tomcat's {@code maxPostSize}
 * covers only form encoding), so one oversized write is a straightforward
 * memory-amplification lever. This filter refuses one:
 *
 * <ul>
 *   <li>a write whose declared {@code Content-Length} is over {@link #MAX_BODY_BYTES}
 *       is answered {@code 413} without the body being read; and</li>
 *   <li>a body that arrives without a length (chunked) is streamed through a
 *       counting wrapper that fails the same way once it passes the cap.</li>
 * </ul>
 *
 * <p>Scoped to exactly the writes {@link ProfileSecurityConfig} guards, so it
 * adds nothing to any route that exists today: {@code POST /api/health} keeps its
 * 405 and a map read is untouched. Installed only with
 * {@code flighttracker.profile.enabled=true} (see
 * {@link ProfileSecurityConfig#profileWriteBodyLimitFilter}) and ordered
 * <em>ahead</em> of the security chain, so an oversized body is refused before the
 * firewall, the CSRF check or any controller reads it.
 */
public class ProfileWriteBodyLimitFilter extends OncePerRequestFilter {

    /** The largest body a profile write may carry: well above the 2 KB data cap. */
    static final long MAX_BODY_BYTES = 16 * 1024;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!ProfileSecurityConfig.isCsrfProtectedWrite(request)) {
            chain.doFilter(request, response);
            return;
        }
        if (request.getContentLengthLong() > MAX_BODY_BYTES) {
            reject(response);
            return;
        }
        try {
            chain.doFilter(new CappedRequest(request), response);
        } catch (BodyTooLargeException tooLarge) {
            if (!response.isCommitted()) {
                reject(response);
            }
        }
    }

    /** The shared {@code 413}, in the app's one-field error shape. */
    private static void reject(HttpServletResponse response) throws IOException {
        response.setStatus(HttpStatus.PAYLOAD_TOO_LARGE.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write("{\"error\":\"" + HttpStatus.PAYLOAD_TOO_LARGE.getReasonPhrase() + "\"}");
    }

    /** Raised by the counting stream once the body passes {@link #MAX_BODY_BYTES}. */
    static class BodyTooLargeException extends IOException {
        BodyTooLargeException() {
            super("request body exceeded " + MAX_BODY_BYTES + " bytes");
        }
    }

    /** Wraps a request so its body reads fail at {@link #MAX_BODY_BYTES}. */
    private static final class CappedRequest extends HttpServletRequestWrapper {

        private final Charset charset;

        CappedRequest(HttpServletRequest request) {
            super(request);
            String encoding = request.getCharacterEncoding();
            this.charset = encoding == null ? StandardCharsets.UTF_8 : Charset.forName(encoding);
        }

        @Override
        public ServletInputStream getInputStream() throws IOException {
            return new CappedInputStream(super.getInputStream());
        }

        @Override
        public BufferedReader getReader() throws IOException {
            return new BufferedReader(new InputStreamReader(getInputStream(), charset));
        }
    }

    /** A {@link ServletInputStream} that throws {@link BodyTooLargeException} past the cap. */
    private static final class CappedInputStream extends ServletInputStream {

        private final ServletInputStream delegate;
        private long read;

        CappedInputStream(ServletInputStream delegate) {
            this.delegate = delegate;
        }

        @Override
        public int read() throws IOException {
            int next = delegate.read();
            if (next != -1) {
                count(1);
            }
            return next;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int count = delegate.read(buffer, offset, length);
            if (count > 0) {
                count(count);
            }
            return count;
        }

        private void count(int bytes) throws IOException {
            read += bytes;
            if (read > MAX_BODY_BYTES) {
                throw new BodyTooLargeException();
            }
        }

        @Override
        public boolean isFinished() {
            return delegate.isFinished();
        }

        @Override
        public boolean isReady() {
            return delegate.isReady();
        }

        @Override
        public void setReadListener(ReadListener listener) {
            delegate.setReadListener(listener);
        }
    }
}
