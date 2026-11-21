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
import java.util.function.Predicate;
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
        StatementSplitter splitter = new StatementSplitter();
        for (String line : text.split("\n", -1)) {
            splitter.accept(new SqlLine(line));
        }
        return splitter.finish();
    }

    /** Line-by-line state of {@link #statements}: the statement being built and its leading comments. */
    private static final class StatementSplitter {
        private final List<Statement> out = new ArrayList<>();
        private final List<String> pendingComments = new ArrayList<>();
        private final StringBuilder raw = new StringBuilder();
        private final StringBuilder code = new StringBuilder();
        private boolean started = false;

        void accept(SqlLine line) {
            if (line.text().trim().isEmpty()) {
                acceptBlank();
            } else if (line.isComment()) {
                acceptComment(line.text());
            } else {
                acceptCode(line);
            }
        }

        /** A blank line ends a comment block, so it detaches comments from the next statement. */
        private void acceptBlank() {
            if (!started) pendingComments.clear();
        }

        private void acceptComment(String line) {
            if (started) raw.append(line).append('\n');
            else pendingComments.add(line);
        }

        private void acceptCode(SqlLine line) {
            if (!started) startStatement();
            String withoutComment = line.withoutComment();
            raw.append(line.text()).append('\n');
            code.append(withoutComment).append('\n');
            if (withoutComment.contains(";")) endStatement();
        }

        private void startStatement() {
            started = true;
            pendingComments.forEach(c -> raw.append(c).append('\n'));
            pendingComments.clear();
        }

        private void endStatement() {
            out.add(new Statement(raw.toString(), code.toString()));
            started = false;
            raw.setLength(0);
            code.setLength(0);
        }

        List<Statement> finish() {
            if (started && !code.toString().isBlank()) {
                out.add(new Statement(raw.toString(), code.toString()));
            }
            return out;
        }
    }

    /** One script line, and how to read it as SQL. */
    private record SqlLine(String text) {

        /** True for a line that is entirely a SQL comment ({@code -- …} or a block-comment line). */
        boolean isComment() {
            String trimmed = text.trim();
            return trimmed.startsWith("--") || trimmed.startsWith("/*") || trimmed.startsWith("*");
        }

        /** Drops a trailing line comment (and any block-comment span) from code, outside quotes. */
        String withoutComment() {
            StringBuilder sb = new StringBuilder();
            boolean inSingleQuote = false;
            int i = 0;
            while (i >= 0 && i < text.length()) {
                int next = inSingleQuote ? i : afterComment(i);
                if (next == i) {
                    char c = text.charAt(i);
                    if (c == '\'') inSingleQuote = !inSingleQuote;
                    sb.append(c);
                    next = i + 1;
                }
                i = next;
            }
            return sb.toString();
        }

        /**
         * Where code resumes if a comment starts at {@code i}: {@code i} itself when none
         * starts there, past the closing {@code *}{@code /} of a block comment, or -1 when
         * the comment runs to the end of the line.
         */
        private int afterComment(int i) {
            if (text.startsWith("--", i)) return -1;
            if (!text.startsWith("/*", i)) return i;
            int end = text.indexOf("*/", i + 2);
            return end < 0 ? -1 : end + 2;
        }
    }

    /** A statement's code, upper-cased with whitespace collapsed, as the rules read it. */
    private record Ddl(String sql) {

        boolean matches(Pattern pattern) {
            return pattern.matcher(sql).find();
        }

        boolean addsNotNullColumnWithoutDefault() {
            return addsNotNullColumn() && !sql.contains("DEFAULT");
        }

        private boolean addsNotNullColumn() {
            return isAlterTableAdd() && sql.contains("NOT NULL");
        }

        private boolean isAlterTableAdd() {
            return sql.startsWith("ALTER TABLE") && sql.contains(" ADD ");
        }
    }

    /** One additive-migrations rule: what breaks it, and the reason quoted in the failure. */
    private record Rule(Predicate<Ddl> isBrokenBy, String reason) {
    }

    /** Checked in order; a statement reports the first rule it breaks. */
    private static final List<Rule> RULES = List.of(
            new Rule(ddl -> ddl.matches(DROP),
                    "DROP is not additive — a dropped table, index or column still needed by the "
                            + "previous jar's statements breaks a rollback: "),
            new Rule(ddl -> ddl.matches(RENAME),
                    "RENAME is not backward-compatible — the previous jar writes the old name: "),
            new Rule(Ddl::addsNotNullColumnWithoutDefault,
                    "ALTER TABLE … ADD … NOT NULL without a DEFAULT — the previous jar's INSERTs "
                            + "omit the column and fail: "));

    /** Returns a description of the rule this statement breaks, or null when it is additive. */
    private static String violationIn(String code) {
        Ddl ddl = new Ddl(code.toUpperCase(Locale.ROOT).replaceAll("\\s+", " ").trim());
        if (ddl.sql().isEmpty()) return null;
        return RULES.stream()
                .filter(rule -> rule.isBrokenBy().test(ddl))
                .findFirst()
                .map(rule -> rule.reason() + ddl.sql())
                .orElse(null);
    }
}
