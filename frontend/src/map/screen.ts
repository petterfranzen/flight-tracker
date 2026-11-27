import { COMPACT_QUERY } from "../ui/a11y";

/** Whether the compact (phone) layout is in force — narrow OR short (see a11y.ts's COMPACT_QUERY). Its own module so the main bundle can ask without pulling in the lazy MapLibre chunk. */
export const isSmallScreen = (): boolean => window.matchMedia(COMPACT_QUERY).matches;
