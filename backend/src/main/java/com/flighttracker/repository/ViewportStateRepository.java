package com.flighttracker.repository;

import com.flighttracker.model.ViewportState;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ViewportStateRepository extends JpaRepository<ViewportState, Integer> {
}
