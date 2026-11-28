package com.flighttracker.service.enrichment;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;

/**
 * A loopback HTTP server for the enrichment clients, which build their own
 * RestClient and so can't be bound to a MockRestServiceServer. Every request
 * is recorded; the reply comes from a handler the test sets.
 */
final class StubHttpServer implements AutoCloseable {

    record Reply(int status, String json) {
    }

    record Recorded(String method, String path, String contentType, String body) {
    }

    private final HttpServer server;
    private final List<Recorded> requests = new CopyOnWriteArrayList<>();
    private volatile Function<Recorded, Reply> handler = request -> new Reply(404, "{}");

    StubHttpServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::serve);
        server.start();
    }

    String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** Every request gets this status and JSON body. */
    void reply(int status, String json) {
        handler = request -> new Reply(status, json);
    }

    void handle(Function<Recorded, Reply> newHandler) {
        handler = newHandler;
    }

    List<Recorded> requests() {
        return List.copyOf(requests);
    }

    /** A loopback URL nothing listens on, so a request to it fails to connect. */
    static String unusedBaseUrl() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            return "http://127.0.0.1:" + socket.getLocalPort();
        }
    }

    private void serve(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        Recorded recorded = new Recorded(exchange.getRequestMethod(), exchange.getRequestURI().getPath(),
                exchange.getRequestHeaders().getFirst("Content-Type"), body);
        requests.add(recorded);
        Reply reply = handler.apply(recorded);
        byte[] bytes = reply.json().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(reply.status(), bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
