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
            violationsIn(read(script)).forEach(v -> violations.add(script.getFilename() + ": " + v));
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

    @Test
    void aStatementAfterABlockCommentOnTheSameLineIsStillChecked() {
        assertThat(violationsIn("/* note */ DROP TABLE a;")).hasSize(1);
        assertThat(violationsIn("/* a comment\n   that spans lines */ DROP TABLE a;")).hasSize(1);
        assertThat(violationsIn("DROP/* hidden */TABLE a;")).hasSize(1);
    }

    @Test
    void commentsAloneAreNotStatements() {
        assertThat(violationsIn("""
                /* drop the old table
                   DROP TABLE a; was here */
                -- DROP TABLE b;
                CREATE TABLE c (id TEXT); /* rename later */
                """)).isEmpty();
    }

    @Test
    void theAllowMarkerStillExemptsAStatement() {
        assertThat(violationsIn(ALLOW_MARKER + " reviewed\n/* note */ DROP TABLE a;")).isEmpty();
    }

    /** The rule each non-exempt statement in {@code script} breaks. */
    private static List<String> violationsIn(String script) {
        List<String> violations = new ArrayList<>();
        for (Statement statement : statements(script)) {
            String finding = violationIn(statement.code());
            if (finding != null && !statement.raw().contains(ALLOW_MARKER)) {
                violations.add(finding);
            }
        }
        return violations;
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
        boolean inBlockComment = false;
        for (String line : text.split("\n", -1)) {
            SqlLine sql = SqlLine.read(line, inBlockComment);
            splitter.accept(sql);
            inBlockComment = sql.endsInBlockComment();
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
            raw.append(line.text()).append('\n');
            code.append(line.code()).append('\n');
            if (line.code().contains(";")) endStatement();
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

    /**
     * One script line read as SQL: its text, its code with every comment removed (a
     * block comment, even one opened on an earlier line, counts as a space), and whether
     * a block comment is still open at its end.
     */
    private record SqlLine(String text, String code, boolean endsInBlockComment) {

        static SqlLine read(String text, boolean inBlockComment) {
            CodeScanner scanner = new CodeScanner(text, inBlockComment);
            scanner.run();
            return new SqlLine(text, scanner.code.toString(), scanner.inBlockComment);
        }

        /** True for a line with no code at all: only comments, or the inside of a block comment. */
        boolean isComment() {
            return code.isBlank();
        }
    }

    /** Copies one line's code, outside quotes, skipping {@code --} and block comments. */
    private static final class CodeScanner {
        private final String text;
        private final StringBuilder code = new StringBuilder();
        private boolean inBlockComment;
        private boolean inSingleQuote = false;
        private int i = 0;

        CodeScanner(String text, boolean inBlockComment) {
            this.text = text;
            this.inBlockComment = inBlockComment;
        }

        void run() {
            while (i < text.length()) {
                if (inBlockComment) skipBlockComment();
                else if (!inSingleQuote && text.startsWith("--", i)) return;
                else if (!inSingleQuote && text.startsWith("/*", i)) openBlockComment();
                else copyChar();
            }
        }

        private void skipBlockComment() {
            int end = text.indexOf("*/", i);
            inBlockComment = end < 0;
            i = end < 0 ? text.length() : end + 2;
        }

        private void openBlockComment() {
            inBlockComment = true;
            code.append(' ');
            i += 2;
        }

        private void copyChar() {
            char c = text.charAt(i++);
            if (c == '\'') inSingleQuote = !inSingleQuote;
            code.append(c);
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
