package com.flighttracker.controller;

import com.flighttracker.dto.TrackStatus;

import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/** The dossier's status-line wording (the label table of docs/agents/PROGRESS.md). */
final class TrackStatusLabels {

    private static final DateTimeFormatter HH_MM_UTC = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneOffset.UTC);

    private TrackStatusLabels() {
    }

    /** The label for one status; null for LIVE. */
    static String label(TrackStatus s) {
        return switch (s.state()) {
            case COVERAGE_LOST -> coverageLost(s);
            case LANDED_INFERRED -> landedInferred(s);
            case ON_GROUND -> "On ground (ADS-B)";
            case LANDED_CONFIRMED -> "Landed (confirmed · " + providerName(s.source()) + ")";
            case AT_GATE -> "At gate" + optionalSuffix(" ", s.gate()) + " (confirmed)";
            default -> null;
        };
    }

    /** The provider's display name, as the frontend shows it; an unknown id is shown as it is. */
    static String providerName(String id) {
        if ("aerodatabox".equals(id)) return "AeroDataBox";
        if ("swedavia".equals(id)) return "Swedavia";
        return id;
    }

    private static String coverageLost(TrackStatus s) {
        StringBuilder out = new StringBuilder("Coverage lost");
        if (s.estimate() != null) out.append(" · est. ±").append(formatRadius(s.estimate().radiusM()));
        TrackStatus.Landing landing = s.landing();
        if (landing != null) {
            out.append(" · landing ");
            if (landing.touchdownAt() != null) out.append('~').append(HH_MM_UTC.format(landing.touchdownAt())).append(" UTC ");
            out.append(where(landing));
        }
        return out.toString();
    }

    private static String landedInferred(TrackStatus s) {
        double confidence = s.confidence() == null ? 0 : s.confidence();
        String where = s.landing() == null ? "" : " · " + where(s.landing());
        return String.format(Locale.ROOT, "Landed %d%% (inferred)", Math.round(confidence * 100)) + where;
    }

    /** The landing airport, plus its runway when known. */
    private static String where(TrackStatus.Landing landing) {
        return landing.airportIcao() + optionalSuffix(" ", landing.runway());
    }

    private static String optionalSuffix(String separator, String value) {
        return value == null ? "" : separator + value;
    }

    private static String formatRadius(double radiusM) {
        if (radiusM < 1000) return Math.round(radiusM / 10.0) * 10 + " m";
        return String.format(Locale.ROOT, radiusM < 10_000 ? "%.1f km" : "%.0f km", radiusM / 1000.0);
    }
}
