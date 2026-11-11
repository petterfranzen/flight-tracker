package com.flighttracker.config;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The additive-migrations rule (section9-hq#249, from Saito's design in §74):
 * migrations are additive and backward-compatible for one release — add
 * nullable columns or new tables; never drop, rename or retype within the
 * rollback window.
 *
 * <p>The database is forward-only: there are no down-migrations, and a
 * rollback lands the previous jar on the file this one already migrated.
 * A release that drops, renames or retypes a column (or adds a NOT NULL
 * column with no default) leaves the old jar failing its INSERTs while
 * {@code /api/health}'s {@code SELECT 1} still reports healthy — a rollback
 * that looks fine and silently loses data. So this guard reads every
 * {@code .sql} script on the classpath (today: {@code schema.sql}, run at
 * startup by {@code spring.sql.init.mode: always}) and fails on:
 *
 * <ul>
 *   <li>{@code DROP} — any dropped table, index or column;</li>
 *   <li>{@code RENAME} — any {@code ALTER TABLE … RENAME}; and</li>
 *   <li>{@code ALTER TABLE … ADD [COLUMN] … NOT NULL} without a {@code DEFAULT}.</li>
 * </ul>
 *
 * <p>A retype needs no separate check: SQLite has no in-place type-change
 * statement, so retyping is only ever drop-and-recreate, which the two rules
 * above already catch.
 *
 * <p>A deliberate exception must be explicit and explained, with an
 * {@code -- additive-migrations: allow <reason>} comment on the line
 * immediately above (or inline with) the statement. The comment block must be
 * contiguous with the statement — a blank line between the two detaches it —
 * so the marker cannot be tucked into an unrelated preamble like
 * {@code schema.sql}'s own header.
 */
class SchemaMigrationGuardTest {

    /** The exception marker the rule text in schema.sql and CLAUDE.md documents. */
    static final String ALLOW_MARKER = "-- additive-migrations: allow";

    private static final Pattern DROP = Pattern.compile("\\bDROP\\b");
    private static final Pattern RENAME = Pattern.compile("\\bRENAME\\b");

    @Test
    void everySchemaStatementIsAdditiveAndBackwardCompatible() throws IOException {
        List<Resource> scripts = schemaScripts();
        assertThat(scripts).as("schema/migration .sql scripts on the classpath").isNotEmpty();

        List<String> violations = new ArrayList<>();
        for (Resource script : scripts) {
            for (Statement statement : statements(read(script))) {
                String finding = violationIn(statement.code());
                if (finding != null && !statement.raw().contains(ALLOW_MARKER)) {
                    violations.add(script.getFilename() + ": " + finding);
                }
            }
        }

        assertThat(violations)
                .as("""
                    Non-additive statement(s) found. Migrations must stay additive and \
                    backward-compatible for one release (add nullable columns or new \
                    tables; never drop, rename or retype) so a rollback to the previous \
                    jar still works. If the statement is a deliberate, reviewed \
                    exception, add `%s <reason>` above it.""", ALLOW_MARKER)
                .isEmpty();
    }

    private static List<Resource> schemaScripts() throws IOException {
        Resource[] found = new PathMatchingResourcePatternResolver()
                .getResources("classpath*:*.sql");
        List<Resource> scripts = new ArrayList<>();
        for (Resource r : found) {
            if (r.isReadable()) scripts.add(r);
        }
        return scripts;
    }

    private static String read(Resource r) throws IOException {
        try (InputStream in = r.getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** One DDL statement, with the comments it carries and its comment-free code. */
    record Statement(String raw, String code) {
    }

    /**
     * Splits a script into statements, keeping each statement's own comments in
     * {@code raw} so the exception marker can be read, and only real code in
     * {@code code} so a comment mentioning "drop" (this schema's header does)
     * cannot false-positive the rules.
     */
    private static List<Statement> statements(String text) {
        List<Statement> out = new ArrayList<>();
        List<String> pendingComments = new ArrayList<>();
        StringBuilder raw = new StringBuilder();
        StringBuilder code = new StringBuilder();
        boolean started = false;

        for (String line : text.split("\n", -1)) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                if (!started) pendingComments.clear();   // a blank line ends a comment block
                continue;
            }
            if (isBlockCommentLine(trimmed)) {
                if (started) raw.append(line).append('\n');
                else pendingComments.add(line);
                continue;
            }
            if (!started) {
                started = true;
                pendingComments.forEach(c -> raw.append(c).append('\n'));
                pendingComments.clear();
            }
            String withoutComment = stripComment(line);
            raw.append(line).append('\n');
            code.append(withoutComment).append('\n');
            if (withoutComment.contains(";")) {
                out.add(new Statement(raw.toString(), code.toString()));
                started = false;
                raw.setLength(0);
                code.setLength(0);
            }
        }
        if (started && !code.toString().isBlank()) {
            out.add(new Statement(raw.toString(), code.toString()));
        }
        return out;
    }

    /** True for a line that is entirely a SQL comment ({@code -- …} or a block-comment line). */
    private static boolean isBlockCommentLine(String trimmed) {
        return trimmed.startsWith("--") || trimmed.startsWith("/*") || trimmed.startsWith("*");
    }

    /** Drops a trailing line comment (and any block-comment span) from code, outside quotes. */
    private static String stripComment(String line) {
        StringBuilder sb = new StringBuilder();
        boolean inSingleQuote = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '\'') {
                inSingleQuote = !inSingleQuote;
                sb.append(c);
                continue;
            }
            if (!inSingleQuote) {
                if (c == '-' && i + 1 < line.length() && line.charAt(i + 1) == '-') break;
                if (c == '/' && i + 1 < line.length() && line.charAt(i + 1) == '*') {
                    int end = line.indexOf("*/", i + 2);
                    if (end < 0) break;
                    i = end + 1;
                    continue;
                }
            }
            sb.append(c);
        }
        return sb.toString();
    }

    /** Returns a description of the rule this statement breaks, or null when it is additive. */
    private static String violationIn(String code) {
        String c = code.toUpperCase(Locale.ROOT).replaceAll("\\s+", " ").trim();
        if (c.isEmpty()) return null;

        if (DROP.matcher(c).find()) {
            return "DROP is not additive — a dropped table, index or column still needed by the "
                    + "previous jar's statements breaks a rollback: " + c;
        }
        if (RENAME.matcher(c).find()) {
            return "RENAME is not backward-compatible — the previous jar writes the old name: " + c;
        }
        if (c.startsWith("ALTER TABLE") && c.contains(" ADD ") && c.contains("NOT NULL")
                && !c.contains("DEFAULT")) {
            return "ALTER TABLE … ADD … NOT NULL without a DEFAULT — the previous jar's INSERTs "
                    + "omit the column and fail: " + c;
        }
        return null;
    }
}
