package com.flighttracker.controller;

import com.flighttracker.service.live.PlaneAllowance;
import org.springframework.web.bind.annotation.RequestParam;

/**
 * /api/flights/live/overview's optional query parameters: cluster grid
 * size, plane cap, per-cell plane cap, and the cluster-free variant
 * switch (see FlightController.liveOverview). {@link #allowance()}
 * clamps them to what the endpoint serves.
 */
public record OverviewParams(@RequestParam(defaultValue = "2") double gridDeg,
                             @RequestParam(defaultValue = "" + OverviewParams.DEFAULT_PLANES) int limit,
                             @RequestParam(defaultValue = "" + OverviewParams.DEFAULT_PER_CELL) int perCell,
                             @RequestParam(defaultValue = "false") boolean declutter) {

    static final int DEFAULT_PLANES = 120;
    static final int DEFAULT_PER_CELL = 6;
    private static final int MAX_PLANES = 2000;
    private static final int MAX_PER_CELL = 20;

    /** gridDeg clamped like /live/clusters', limit to [0, 2000], perCell to [1, 20]. */
    PlaneAllowance allowance() {
        return new PlaneAllowance(ClusterGrid.clamp(gridDeg),
                Math.min(MAX_PLANES, Math.max(0, limit)),
                Math.min(MAX_PER_CELL, Math.max(1, perCell)));
    }
}
