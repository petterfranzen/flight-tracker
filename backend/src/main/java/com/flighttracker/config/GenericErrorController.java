package com.flighttracker.config;

import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.webmvc.error.ErrorController;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * The public app's error response, deliberately saying nothing about what is
 * serving it.
 *
 * <p>Spring Boot's own {@code BasicErrorController} answers every error with
 * its default body ({@code timestamp}/{@code status}/{@code error}/{@code path},
 * and a "Whitelabel Error Page" for an HTML client). That shape is a
 * well-known fingerprint of the framework, and the task is to not hand one
 * out — the same reasoning that keeps {@code /api/ops/stats} tech-neutral
 * (see {@code OpsStatsFilter}). This controller replaces it (Boot's
 * {@code ErrorMvcAutoConfiguration} backs off on any user
 * {@code ErrorController} bean) and answers with one generic field, the
 * standard HTTP reason phrase for the status, and no date or path echo.
 *
 * <p>Registered for the container's error page path, so it also serves the
 * error dispatch for a 404, 405, 400 or 500 the MVC layer raises, and a
 * direct request to {@code /error} itself.
 */
@Controller
public class GenericErrorController implements ErrorController {

    private static final String ERROR_PATH = "${server.error.path:${error.path:/error}}";

    @RequestMapping(ERROR_PATH)
    public void error(HttpServletRequest request, HttpServletResponse response) throws IOException {
        HttpStatus status = resolveStatus(request);
        response.setStatus(status.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setHeader("Cache-Control", "no-store");
        response.getWriter().write("{\"error\":\"" + status.getReasonPhrase() + "\"}");
    }

    private static HttpStatus resolveStatus(HttpServletRequest request) {
        Object code = request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
        if (code instanceof Integer value) {
            HttpStatus resolved = HttpStatus.resolve(value);
            if (resolved != null) {
                return resolved;
            }
        }
        return HttpStatus.INTERNAL_SERVER_ERROR;
    }
}
