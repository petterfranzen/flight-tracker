package com.flighttracker.controller;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

class GeoControllerTest {

    private final GeoController controller = new GeoController();

    @Test
    void returnsThePointNeverCached() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("CF-IPLatitude", "53.48");
        request.addHeader("CF-IPLongitude", "-2.24");

        var response = controller.geo(request);

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().lat()).isEqualTo(53.5);
        assertThat(response.getHeaders().getCacheControl()).contains("no-store");
    }

    @Test
    void noHeadersIsNoContent() {
        var response = controller.geo(new MockHttpServletRequest());

        assertThat(response.getStatusCode().value()).isEqualTo(204);
        assertThat(response.getBody()).isNull();
        assertThat(response.getHeaders().getCacheControl()).contains("no-store");
    }
}
