# Neovim basics

Neovim is modal: keys do different things depending on which "mode" you're in.
You'll live in two modes almost all the time.

- **Normal mode** — the default. Keys are commands, not text. `Esc` always gets you here.
- **Insert mode** — actually typing text. Enter with `i`, `a`, `o`; leave with `Esc`.

## Getting in and out
| Keys | Does |
|---|---|
| `i` | insert before cursor |
| `a` | insert after cursor |
| `o` / `O` | open a new line below / above and insert |
| `Esc` | back to normal mode |
| `:w` | save |
| `:q` | quit |
| `:wq` or `ZZ` | save and quit |
| `:q!` | quit without saving |

## Moving around (normal mode)
| Keys | Does |
|---|---|
| `h j k l` | left / down / up / right |
| `w` / `b` | next word / previous word |
| `0` / `$` | start / end of line |
| `gg` / `G` | top / bottom of file |
| `{` / `}` | previous / next blank-line paragraph |
| `Ctrl-d` / `Ctrl-u` | half-page down / up |
| `%` | jump to matching bracket |

## Editing
| Keys | Does |
|---|---|
| `x` | delete character |
| `dd` | delete (cut) line |
| `yy` | yank (copy) line |
| `p` / `P` | paste after / before cursor |
| `u` | undo |
| `Ctrl-r` | redo |
| `.` | repeat the last change — this one earns its keep constantly |
| `dw`, `de`, `d$` | delete to next word / end of word / end of line |
| `ciw` | change the word under the cursor (works for any text object: `ci"`, `ci(`, `dit` for a tag body, etc.) |
| `v`, `V`, `Ctrl-v` | visual select: char, line, block |

The `d`/`c`/`y` + motion pattern (delete/change/yank + a movement) is the
thing that makes Vim fast once it clicks — `d}` deletes to the end of the
paragraph, `ci(` changes everything inside the parens you're standing in,
etc.

## Search
| Keys | Does |
|---|---|
| `/text` then `Enter` | search forward |
| `n` / `N` | next / previous match |
| `:%s/old/new/g` | replace all `old` with `new` in the file |

## What this config adds on top (leader = Space)
| Keys | Does |
|---|---|
| `Space ff` | find file by name (Telescope) |
| `Space fg` | grep text across the project |
| `Space fb` | switch between open buffers |
| `Space t` | toggle the file tree |
| `gd` | go to definition (LSP) |
| `K` | hover docs for whatever's under the cursor |
| `Space rn` | rename symbol project-wide |
| `Space ca` | code actions (quick fixes, imports, etc.) |
| `Space e` | show the diagnostic on the current line |

`which-key` pops up a menu of what's available any time you hit `Space` and
pause — you don't need to memorise this table, just start pressing Space.

## A realistic first session
1. `nvim backend/pom.xml` — opens the file, drops you in normal mode.
2. `Space ff` — type `Flight` — jump straight to `FlightController.java`.
3. `gd` on a method call to jump to its definition, `Ctrl-o` to jump back.
4. `ciw` to rename a variable at the cursor, `Esc`, `.` to repeat that same
   change somewhere else.
5. `:wq` to save and quit.

That's genuinely most of daily-driver Neovim. Everything else (macros,
marks, folds) is worth learning later, once these are muscle memory.
