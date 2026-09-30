/**
 * A ~50-line typed observable store — replaces the piece of React state
 * FlightMap.tsx used to hold. One flat object of named slots; every UI
 * module gets the same store instance and reads/writes named slots rather
 * than each owning its own local state. Action functions (selectAircraft,
 * toggleTheme, etc.) are plain values too — set once at boot in main.ts and
 * never reassigned — so a UI module needs nothing beyond `store.get`/`set`/
 * `subscribe` to both render and act.
 */
export type Listener<T> = (value: T) => void;

export class Store<S extends Record<string, unknown>> {
  private state: S;
  private listeners: { [K in keyof S]?: Set<Listener<S[K]>> } = {};

  constructor(initial: S) {
    this.state = initial;
  }

  get<K extends keyof S>(key: K): S[K] {
    return this.state[key];
  }

  getState(): Readonly<S> {
    return this.state;
  }

  set<K extends keyof S>(key: K, value: S[K]): void {
    if (this.state[key] === value) return;
    this.state[key] = value;
    this.listeners[key]?.forEach((listener) => listener(value));
  }

  /** Functional update — reads the current value, writes back the result. */
  update<K extends keyof S>(key: K, fn: (prev: S[K]) => S[K]): void {
    this.set(key, fn(this.state[key]));
  }

  /** Calls `listener` on every change to `key`. Returns an unsubscribe function. */
  subscribe<K extends keyof S>(key: K, listener: Listener<S[K]>): () => void {
    (this.listeners[key] ??= new Set()).add(listener);
    return () => {
      this.listeners[key]?.delete(listener);
    };
  }

  /** Subscribes to several keys at once with one callback (ignores which one changed). */
  subscribeMany(keys: (keyof S)[], listener: () => void): () => void {
    const unsubs = keys.map((key) => this.subscribe(key, listener));
    return () => unsubs.forEach((u) => u());
  }
}
