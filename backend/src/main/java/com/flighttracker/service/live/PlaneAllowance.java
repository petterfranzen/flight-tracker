package com.flighttracker.service.live;

/**
 * How many planes {@link LiveStateStore#overview} may draw: at most
 * {@code maxPlanes}, {@code perCell} per {@code gridDeg} cell. gridDeg is
 * trusted as already clamped by the caller.
 */
public record PlaneAllowance(double gridDeg, int maxPlanes, int perCell) {
}
