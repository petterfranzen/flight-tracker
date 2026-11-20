package com.flighttracker.service.confirmation;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;

/** The match keys a board entry and a live aircraft are compared on. */
class BoardEntryNormalizationTest {

    @ParameterizedTest(name = "callsign ''{0}'' -> ''{1}''")
    @CsvSource(value = {"SAS1234, SAS1234", "' sas1234 ', SAS1234", "'sas 1234', SAS 1234", "'', ''", "NULL, ''"},
            nullValues = "NULL")
    void callsign_isTrimmedAndUpperCased(String raw, String expected) {
        assertThat(BoardEntry.normalizeCallsign(raw)).isEqualTo(expected);
    }

    @ParameterizedTest(name = "registration ''{0}'' -> ''{1}''")
    @CsvSource(value = {"SE-RUA, SERUA", "se-rua, SERUA", "' se - r ua ', SERUA", "SERUA, SERUA", "'', ''",
            "NULL, ''"}, nullValues = "NULL")
    void registration_dropsSpacesAndDashesAndIsUpperCased(String raw, String expected) {
        assertThat(BoardEntry.normalizeRegistration(raw)).isEqualTo(expected);
    }
}
