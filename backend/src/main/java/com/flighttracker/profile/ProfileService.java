package com.flighttracker.profile;

import com.flighttracker.repository.FavoriteRepository;
import com.flighttracker.repository.ProfileRepository;
import com.flighttracker.repository.WatchedFlightRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Profile writes that need more than one table.
 *
 * Currently one thing: the explicit, transactional account delete the design
 * (§2) insists on. The schema declares no foreign keys between these tables,
 * and SQLite only enforces the ones it does have with PRAGMA foreign_keys=ON,
 * which the pooled connections do not set — so ON DELETE CASCADE would never
 * fire. The children are therefore deleted by hand, before the profile, inside
 * one transaction, so a failed delete leaves the account whole.
 */
@Service
public class ProfileService {

    private final ProfileRepository profiles;
    private final FavoriteRepository favorites;
    private final WatchedFlightRepository watchedFlights;
    private final TransactionTemplate transactionTemplate;

    public ProfileService(ProfileRepository profiles,
                          FavoriteRepository favorites,
                          WatchedFlightRepository watchedFlights,
                          TransactionTemplate transactionTemplate) {
        this.profiles = profiles;
        this.favorites = favorites;
        this.watchedFlights = watchedFlights;
        this.transactionTemplate = transactionTemplate;
    }

    /**
     * Erases a profile and everything attached to it (erasure, design §2.1),
     * in one transaction. Returns true when a profile row was actually deleted,
     * false when there was nothing to delete — the API answers 204 either way,
     * so a caller cannot probe for existence.
     */
    public boolean deleteProfile(String profileId) {
        Boolean deleted = transactionTemplate.execute(status -> {
            favorites.deleteAllForProfile(profileId);
            watchedFlights.deleteAllForProfile(profileId);
            return profiles.deleteById(profileId) > 0;
        });
        return Boolean.TRUE.equals(deleted);
    }
}
