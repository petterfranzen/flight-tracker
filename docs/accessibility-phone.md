# Phone accessibility pass (section9-hq#182)

The phone UI (390x844 and 360x740) checked against the house rules and WCAG AA,
and fixed where it fell short. `frontend/tests/a11y-phone.spec.ts` is the
repeatable check for the measurable parts (names, roles, focus, tap targets,
reduced motion); everything below is what that spec and a manual sweep found.

## What was fixed

**Names, roles, focus (criterion 1).** Every icon-only control already carried
an `aria-label`; the gaps were behaviour, not naming:

- The three phone overlays (search, Favourites, legend) and the resume dialog
  now become real modal dialogs while they are modal — `role="dialog"`,
  `aria-modal="true"`, a label — and go back to a plain inline element on
  desktop, where the same markup is a side card rather than a modal.
- Tab is trapped inside a modal panel, Escape closes it, and focus returns to
  the control that opened it (the FAB). One shared helper does all three
  (`frontend/src/ui/a11y.ts`), so the four panels cannot drift apart.
- Escape also closes the watch panel and the aircraft dossier at every width
  (they are not modal, so they get the key without a trap); the shared handler
  stands down while a modal panel is open, so one keypress never closes two
  things. The search box already closed its own dropdown on Escape, and still
  does.
- The focus ring was only drawn for `a` and `button`; it now covers `input`,
  `select`, `textarea` and anything with a `tabindex` as well. Tokens only
  (`--color-focus`), no new colours.

**Tap targets (criterion 2).** The house minimum is 44x44. The spec measures
both the element's box and whether a point half a target out along each axis
actually hits it. Fixed at 390 and 360:

- the dossier sheet's ✕ (was 32x32), its expand handle, its two favourite
  toggles and "Focus plane" (all text-sized);
- the search result rows, the search overlay's close button and the two search
  fields (~39px tall);
- the Favourites drawer's close button and each row's remove ✕ (~25px);
- the legend's close button and its four swatch rows (~16px tall);
- the watch panel's four form fields (~30px);
- the install pill's action and dismiss buttons (were 44px-tall *hit* areas drawn
  by a `::after`, but only on a phone now is the box itself 44px).

The Watch stop button and the legend rows — the two the task names — are
asserted at 360x740 specifically.

**Toasts and status (criterion 3).** The departure toast and the install pill
were already `role="status" aria-live="polite"`. Added the same to the things
that were silent: the search "Searching…"/"No matching flights" rows, the watch
panel's search message, the Favourites "none live right now" hint, and the
Active/Seen count chip (on a stable wrapper, so a re-render does not replace the
live region itself). None of them take focus. The departure toast used to
auto-dismiss after 15s whatever the user was doing; it now suspends that
countdown while anything inside it has focus, so a keyboard user can reach
"Go to" and "Dismiss".

**Reduced motion (criterion 5).** The boot screen and the plane fade-in already
read the preference. Added:

- every camera move (`setView`, `setZoom`, `flyTo`, `panTo` in
  `frontend/src/map/map.ts`) jumps to the same final camera instead of easing
  or flying; and
- a `prefers-reduced-motion` block in `FlightMap.css` that shortens every
  animation and transition the DOM chrome runs (the boot screen's fade was the
  last one still moving).

The spec asserts both: with the preference on, `isMoving()` is false straight
after each call and a probe transition collapses; with it off, the same call
animates and the probe keeps its 0.45s. Without that second half the first
proves nothing.

**Contrast (criterion 4).** Every cyberpunk *text* pair already passes AA — the
worst is `--color-text-muted` on `--color-panel` at 5.71:1, and body text is
16.72:1. The failure was non-text (WCAG 1.4.11): `--color-panel-border`, which
draws the boundary of every button, input and panel edge, was 1.44:1 against
`--color-panel` and 1.55:1 against `--color-bg` — effectively invisible. Lifted
to `#446488`, 3.06:1 on the panel and 3.31:1 on the background, which is the one
token change in `FlightMap.css`. Text on the new border still passes
(`--color-text` 5.46:1, `--color-marker-watched` 4.74:1), so nothing that sat on
a hovered border regressed. Measured pairs:

| pair | before | after |
| --- | --- | --- |
| `--color-panel-border` / `--color-panel` | 1.44 | 3.06 |
| `--color-panel-border` / `--color-bg` | 1.55 | 3.31 |
| `--color-text` / `--color-panel-border` | — | 5.46 |
| `--color-text` / `--color-panel` | 16.72 | 16.72 |
| `--color-text-muted` / `--color-panel` | 5.71 | 5.71 |
| `--color-accent` / `--color-panel` | 11.88 | 11.88 |
| `--color-warn` / `--color-panel` | 5.79 | 5.79 |

## Not fixed / still open

- **The bottom dock is hidden on a phone** (`Dock.css`, `max-width: 768px`). Its
  four tiles are 44x44 and named, but they are not in a phone's hit map or tab
  order at all, so the task's "Dock" entry is desktop-only chrome. Left as it
  is — the comment there says it deliberately duplicates the phone FABs.
- **The default (non-cyberpunk) theme's `--color-panel-border` (`#2c3947`) still
  fails 1.4.11** the same way (1.44:1). It was left alone: `index.html` always
  sets `data-theme="cyberpunk"`, so those fallback tokens never render, and
  changing them is a visual decision outside this pass.
- **Two hard-coded colours remain** (`#04121d` for text on an accent button, and
  `rgba(77, 178, 255, 0.16)` for the hover/active tint) — both predate this pass
  and both pass contrast; converting them to tokens is a tidy-up, not a fix.
- **The watch list's last row sits just below the fold** of its 320px scroll box
  at 360x740 (the ✕ needs a small scroll to reach). It is a 44x44 target once
  scrolled to, which is what the spec asserts; the layout itself was not
  changed.
- **The departure toast cannot be raised in a test.** It needs a watched flight
  to leave the ground, so the spec checks its buttons' declared 44px minimum
  instead of a live hit test.
- **axe-core was not added.** Playwright's own measurements cover the
  acceptance list; adding and pinning an axe dependency to say the same thing
  was not worth the supply-chain surface.
