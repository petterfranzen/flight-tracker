package com.flighttracker.ops;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;

/**
 * GET /api/ops/stats: service stats (OpsStats) for the coordinator and the
 * ops agent, so memory and I/O can be watched without a console.
 *
 * A filter, not a controller, so the path stays indistinguishable from any
 * unknown one: unless the request carries a valid Cloudflare Access token
 * (AccessTokenVerifier), the filter does nothing and the request continues
 * to the SPA fallback like every other unmatched path. There is no 401/403
 * to reveal that the endpoint exists.
 */
@Component
public class OpsStatsFilter extends OncePerRequestFilter {

    static final String PATH = "/api/ops/stats";
    static final String ACCESS_TOKEN_HEADER = "Cf-Access-Jwt-Assertion";

    private final AccessTokenVerifier verifier;
    private final OpsStatsReader reader;
    private final ObjectMapper mapper;

    public OpsStatsFilter(AccessTokenVerifier verifier, OpsStatsReader reader, ObjectMapper mapper) {
        this.verifier = verifier;
        this.reader = reader;
        this.mapper = mapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !PATH.equals(request.getRequestURI());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!"GET".equals(request.getMethod()) || !verifier.verify(request.getHeader(ACCESS_TOKEN_HEADER))) {
            chain.doFilter(request, response);
            return;
        }
        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader("Cache-Control", "no-store");
        mapper.writeValue(response.getOutputStream(), reader.read());
    }
}
