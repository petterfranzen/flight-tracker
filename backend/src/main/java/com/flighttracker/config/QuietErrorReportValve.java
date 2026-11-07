package com.flighttracker.config;

import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ErrorReportValve;

/**
 * Tomcat's default {@code ErrorReportValve} answers a request the container
 * itself rejects (a malformed URI or header, before any of the app's code
 * runs) with its own HTML status page — Tahoma and #525D76, the container's
 * look, which fingerprints the stack just as the default Spring error body
 * does. {@code showReport=false} alone does not remove that page: the valve
 * always writes its status header and only gates the detail on the flag.
 *
 * <p>So this overrides {@code report} to write nothing and to consume the
 * response's "error reported" flag. That also keeps Boot's own no-detail
 * {@code ErrorReportValve} — which Boot appends to the same host pipeline —
 * from writing the page in turn: it checks the same flag and finds it taken.
 * The result is the status and an empty body, and nothing else.
 *
 * <p>Installed by {@link TomcatErrorPageConfig} via the host's
 * {@code errorReportValveClass}; Tomcat instantiates it reflectively, so the
 * no-argument constructor is what runs.
 */
public class QuietErrorReportValve extends ErrorReportValve {

    public QuietErrorReportValve() {
        setShowReport(false);
        setShowServerInfo(false);
    }

    @Override
    protected void report(Request request, Response response, Throwable throwable) {
        response.setErrorReported();
    }
}
