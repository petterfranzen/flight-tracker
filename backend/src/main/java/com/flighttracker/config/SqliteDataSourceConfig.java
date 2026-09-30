package com.flighttracker.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.io.File;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Cloud migration A2 (PLAN.md §6 item 3): replaces Spring Boot's
 * autoconfigured Postgres DataSource with a hand-built SQLite one — a
 * custom @Bean DataSource here means DataSourceAutoConfiguration backs off
 * entirely (its standard @ConditionalOnMissingBean behaviour), so there's
 * no conflicting spring.datasource.* configuration to also maintain.
 *
 * Every PRAGMA PLAN.md specifies is encoded directly in the JDBC URL's
 * query string — the xerial sqlite-jdbc driver applies these to *every*
 * physical connection it opens (not just one), which is exactly what a
 * pooled DataSource needs: HikariCP can open a fresh connection at any
 * time (after the pool recycles one, say), and that connection must carry
 * the same pragmas as the rest of the pool. Simpler and less
 * version-fragile than reflectively wiring a SQLiteConfig through Hikari's
 * dataSourceClassName/addDataSourceProperty mechanism.
 *
 * auto_vacuum=INCREMENTAL is deliberately *not* in the pooled PRAGMAS
 * string below: SQLite only honours that setting before a database's
 * first table is created (silently ignored afterwards), and it needs to
 * win a real race against journal_mode=WAL. Switching journal_mode is
 * itself a transaction that finalizes the database file's page 1 (which
 * is where auto_vacuum's value is stored) — and Hikari opens its first
 * pooled connection, with journal_mode=WAL in that connection's URL,
 * during HikariDataSource construction, *before* Spring's schema.sql
 * script initializer ever runs. Putting `PRAGMA auto_vacuum=INCREMENTAL;`
 * as schema.sql's first statement (as PLAN.md's own text suggests) loses
 * that race on a fresh database: by the time schema.sql runs, some pooled
 * connection has already flipped journal_mode and finalized page 1 with
 * SQLite's default auto_vacuum=NONE, and schema.sql's own attempt becomes
 * a no-op — confirmed empirically (PRAGMA auto_vacuum read back 0, not 2,
 * after a real app boot against a fresh file). setAutoVacuumOnFreshDatabase
 * below wins that race instead: a bare, un-pragma'd connection (no
 * journal_mode=WAL, nothing else that could write page 1 first) sets
 * auto_vacuum and is closed *before* the pooled DataSource — and its
 * journal_mode=WAL connections — ever touch the file.
 */
@Configuration
public class SqliteDataSourceConfig {

    private static final Logger log = LoggerFactory.getLogger(SqliteDataSourceConfig.class);

    // journal_mode=WAL: concurrent readers don't block the single writer.
    // synchronous=NORMAL: safe under WAL (only a full power loss, not just
    // an app crash, can lose the last commit) and meaningfully faster than
    // FULL. busy_timeout=5000: the single-writer-lock cushion PLAN.md's own
    // "SQLite rules that bite" calls for — the sweep insert and retention
    // batches both take that lock, and 5s covers realistic overlap between
    // them rather than failing a writer outright. temp_store=MEMORY: this
    // app's temp tables/indexes (sort operations, etc.) are small and this
    // avoids extra disk I/O for them. cache_size=-65536: ~64MB page cache
    // (negative value = KiB, not page count). mmap_size=268435456: 256MB
    // memory-mapped I/O window, cuts read syscall overhead for the hot
    // working set. foreign_keys=OFF: matches this schema's Postgres
    // predecessor, which never declared FK constraints as CHECK-enforced
    // either (they were documentation-only REFERENCES clauses); SQLite
    // defaults this off anyway, set explicitly so it's never a surprise if
    // that default ever changes.
    private static final String PRAGMAS =
            "journal_mode=WAL&synchronous=NORMAL&busy_timeout=5000&temp_store=MEMORY"
                    + "&cache_size=-65536&mmap_size=268435456&foreign_keys=false";

    @Bean
    public DataSource dataSource(@Value("${flighttracker.db-path:./data/flighttracker.db}") String dbPath) {
        return buildDataSource(dbPath);
    }

    /**
     * Extracted as a static, reusable builder — the integration tests
     * (PLAN.md §6 item 8: "insert -> live read -> retention -> vacuum"
     * against a temp-file SQLite, no Testcontainers) need the exact same
     * pooled-connection/PRAGMA setup a real app boot gets, not a
     * hand-rolled approximation that could silently drift from it.
     */
    public static DataSource buildDataSource(String dbPath) {
        File dbFile = new File(dbPath);
        File parent = dbFile.getAbsoluteFile().getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
            throw new IllegalStateException("Could not create database directory: " + parent);
        }
        boolean freshDatabase = !dbFile.exists();
        log.info("SQLite database: {} ({})", dbFile.getAbsolutePath(), freshDatabase ? "new" : "existing");
        if (freshDatabase) {
            setAutoVacuumOnFreshDatabase(dbFile);
        }

        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:sqlite:" + dbFile.getAbsolutePath() + "?" + PRAGMAS);
        config.setDriverClassName("org.sqlite.JDBC");
        // PLAN.md §6 item 3: "Hikari maximumPoolSize: 4" — deliberately
        // small. SQLite has exactly one writer at a time regardless of
        // pool size (WAL allows concurrent readers alongside that one
        // writer, not concurrent writers), so a large pool would just mean
        // more connections contending for the same single write lock
        // behind busy_timeout, not more real concurrency.
        config.setMaximumPoolSize(4);
        config.setPoolName("sqlite-pool");
        return new HikariDataSource(config);
    }

    /**
     * Sets auto_vacuum=INCREMENTAL on a fresh database file before the
     * pooled DataSource (and its journal_mode=WAL connections) ever opens
     * it — see this class's own javadoc for why that ordering matters. A
     * plain, un-pooled DriverManager connection with no PRAGMAs of its own
     * in the URL: this must be the *first* thing that ever touches the
     * file, and closed again immediately, so the pooled DataSource built
     * right after starts against a file that already has this setting
     * baked into its page 1.
     */
    private static void setAutoVacuumOnFreshDatabase(File dbFile) {
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + dbFile.getAbsolutePath());
             Statement statement = connection.createStatement()) {
            statement.execute("PRAGMA auto_vacuum = INCREMENTAL");
        } catch (SQLException e) {
            throw new IllegalStateException("Could not set auto_vacuum on fresh database: " + dbFile, e);
        }
    }
}
