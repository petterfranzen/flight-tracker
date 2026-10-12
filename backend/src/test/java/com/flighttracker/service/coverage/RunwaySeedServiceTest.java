package com.flighttracker.service.coverage;

import com.flighttracker.config.SqliteDataSourceConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ScriptUtils;

import javax.sql.DataSource;
import java.io.ByteArrayInputStream;
import java.io.Closeable;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Parses the real bundled runways.tsv, and runs the seed against a
 * temp-file SQLite with the unmodified schema.sql (same setup as
 * SqlitePersistenceIntegrationTest).
 */
class RunwaySeedServiceTest {

    @TempDir
    Path tempDir;

    private DataSource dataSource;
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("runway-test.db").toString());
        jdbcTemplate = new JdbcTemplate(dataSource);
        try (Connection connection = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(connection, new ClassPathResource("schema.sql"));
        }
    }

    @AfterEach
    void tearDown() {
        if (dataSource instanceof Closeable closeable) {
            try {
                closeable.close();
            } catch (Exception ignored) {
            }
        }
    }

    @Test
    void bundledFile_hasArlandaRunwaysWithTrueHeadings() {
        List<Runway> all = RunwaySeedService.readBundled();
        assertThat(all.size()).isGreaterThan(10_000);

        List<Runway> essa = all.stream().filter(r -> r.airportIcao().equals("ESSA")).toList();
        assertThat(essa).extracting(Runway::ident)
                .containsExactlyInAnyOrder("01L", "19R", "01R", "19L", "08", "26");

        // True headings (not magnetic), as in the OurAirports *_heading_degT columns.
        assertHeading(essa, "01L", 10.0);
        assertHeading(essa, "19R", 190.0);
        assertHeading(essa, "01R", 10.4);
        assertHeading(essa, "19L", 190.4);
        assertHeading(essa, "08", 75.9);
        assertHeading(essa, "26", 255.9);

        Runway r01l = essa.stream().filter(r -> r.ident().equals("01L")).findFirst().orElseThrow();
        assertThat(r01l.thresholdLat()).isCloseTo(59.6373, within(0.001));
        assertThat(r01l.thresholdLon()).isCloseTo(17.9132, within(0.001));
        assertThat(r01l.lengthM()).isCloseTo(3301.0, within(5.0));
        assertThat(r01l.elevationM()).isNotNull();
    }

    @Test
    void bundledFile_loadsIntoIndexAroundArlanda() {
        RunwayIndex index = new RunwayIndex();
        index.replace(RunwaySeedService.readBundled());

        assertThat(index.atAirport("ESSA")).hasSize(6);
        assertThat(index.near(59.65, 17.94, 5_000))
                .extracting(Runway::airportIcao).containsOnly("ESSA").hasSize(6);
    }

    @Test
    void parse_handlesEmptyElevationAndSkipsMalformedLines() throws Exception {
        String tsv = "airport_icao\tident\tthreshold_lat\tthreshold_lon\theading_deg\televation_m\tlength_m\n"
                + "AAAA\t09\t10.5\t20.5\t90.0\t\t1500\n"
                + "AAAA\t27\t10.5\t20.6\t270.0\t12\t1500\n"
                + "broken line\n"
                + "BBBB\t01\tx\t1\t2\t3\t4\n";

        List<Runway> parsed = RunwaySeedService.parse(
                new ByteArrayInputStream(tsv.getBytes(StandardCharsets.UTF_8)));

        assertThat(parsed).containsExactly(
                new Runway("AAAA", "09", 10.5, 20.5, 90.0, null, 1500.0),
                new Runway("AAAA", "27", 10.5, 20.6, 270.0, 12.0, 1500.0));
    }

    @Test
    void sync_isIdempotentAndLoadsTheIndex() {
        RunwayIndex index = new RunwayIndex();
        RunwaySeedService service = new RunwaySeedService(jdbcTemplate, index);

        service.sync();
        Integer first = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runway", Integer.class);
        service.sync();
        Integer second = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runway", Integer.class);

        assertThat(first).isEqualTo(RunwaySeedService.readBundled().size());
        assertThat(second).isEqualTo(first);
        assertThat(index.size()).isEqualTo(first);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT heading_deg FROM runway WHERE airport_icao = 'ESSA' AND ident = '08'", Double.class))
                .isCloseTo(75.9, within(0.01));
    }

    @Test
    void upsert_updatesChangedRowsInPlace() {
        RunwaySeedService service = new RunwaySeedService(jdbcTemplate, new RunwayIndex());
        service.upsert(List.of(new Runway("AAAA", "09", 10.0, 20.0, 90.0, null, 1500.0)));
        service.upsert(List.of(new Runway("AAAA", "09", 10.1, 20.0, 91.0, 5.0, 1600.0)));

        assertThat(jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runway", Integer.class)).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT length_m FROM runway WHERE airport_icao = 'AAAA'", Double.class)).isEqualTo(1600.0);
    }

    private static void assertHeading(List<Runway> runways, String ident, double expected) {
        Runway r = runways.stream().filter(x -> x.ident().equals(ident)).findFirst().orElseThrow();
        assertThat(r.headingDeg()).as(ident).isCloseTo(expected, within(2.0));
    }
}
