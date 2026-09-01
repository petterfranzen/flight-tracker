package com.flighttracker.controller;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.ViewportService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * No DB, no Spring context — FlightPositionRepository/ViewportService are
 * mocked, and FlightController is constructed directly. Covers /search's
 * branching (airport takes over from q entirely) and escaping, not
 * FlightPositionRepository's own SQL (that's a native query, out of scope
 * for a DB-less unit test — see this repo's Playwright/blackbox suite for
 * end-to-end coverage).
 */
@ExtendWith(MockitoExtension.class)
class FlightControllerTest {

    @Mock
    private FlightPositionRepository positionRepository;
    @Mock
    private ViewportService viewportService;

    private FlightController controller() {
        return new FlightController(positionRepository, viewportService);
    }

    @Test
    void airportNonBlank_callsSearchByAirportOnly_ignoringQEvenIfPresent() {
        when(positionRepository.searchByAirport(any(), any(), any(), anyInt()))
                .thenReturn(List.of());

        controller().search("SAS123", "Arlanda");

        verify(positionRepository).searchByAirport(eq("%Arlanda%"), any(), any(), eq(8));
        verify(positionRepository, never()).searchLive(any(), any(), any(), any(), anyInt());
    }

    @Test
    void airportBlank_fallsBackToSearchLiveWithQ() {
        when(positionRepository.searchLive(any(), any(), any(), any(), anyInt()))
                .thenReturn(List.of());

        controller().search("SAS", "  ");

        verify(positionRepository).searchLive(eq("%SAS%"), eq("SAS%"), any(), any(), eq(8));
        verify(positionRepository, never()).searchByAirport(any(), any(), any(), anyInt());
    }

    @Test
    void allBlank_returnsEmptyListWithoutCallingRepository() {
        List<FlightPosition> result = controller().search(null, null);

        assertThat(result).isEmpty();
        verifyNoInteractions(positionRepository);
    }

    @Test
    void qWithLiteralPercent_isEscapedBeforeMatching() {
        when(positionRepository.searchLive(any(), any(), any(), any(), anyInt()))
                .thenReturn(List.of());

        controller().search("50%", null);

        verify(positionRepository).searchLive(eq("%50\\%%"), eq("50\\%%"), any(), any(), eq(8));
    }

    @Test
    void qWithLiteralUnderscore_isEscapedBeforeMatching() {
        when(positionRepository.searchLive(any(), any(), any(), any(), anyInt()))
                .thenReturn(List.of());

        controller().search("a_b", null);

        verify(positionRepository).searchLive(eq("%a\\_b%"), eq("a\\_b%"), any(), any(), eq(8));
    }

    @Test
    void qWithLiteralBackslash_isEscapedBeforeMatching() {
        when(positionRepository.searchLive(any(), any(), any(), any(), anyInt()))
                .thenReturn(List.of());

        controller().search("x\\y", null);

        verify(positionRepository).searchLive(eq("%x\\\\y%"), eq("x\\\\y%"), any(), any(), eq(8));
    }
}
