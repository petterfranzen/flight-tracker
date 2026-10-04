/** A phone-sized viewport. Its own module so the main bundle can ask without pulling in the lazy MapLibre chunk. */
export const isSmallScreen = (): boolean => window.matchMedia("(max-width: 768px)").matches;
