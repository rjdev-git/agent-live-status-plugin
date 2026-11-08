# Product — opencode-subagent-model

Live subagent-model status for the OpenCode TUI: a panel shows the project's
subagent team — which roles exist, which are working, on which model, and how
full each model's context window is.

Requirements R1-R12 are the contract. Numbers here are binding: any change to
one moves its design section and its boundary test fixtures in the same
commit.

## R1 — Always-visible team panel

The sidebar renders a team panel whenever the host knows at least one
subagent-capable agent. The panel never hides while that is true.

- Title: `Project Team Members N/M` in the theme's base (white) colour.
  `N` = roles with a working instance; `M` = roles known.
- Placement: `sidebar.content` by default; `sidebar.footer` and
  `prompt.footer` selectable.
- Body: maximum 10 lines, excluding the title and the overflow line.
- `compact` mode replaces the panel with the single line `sub N`
  (N = running subagent count).

## R2 — Role rows

One row per subagent-capable agent: builtin agents plus project agent
definitions, excluding agents marked `hidden` and primary agents.

- Row: two-digit number (` 1.`, `20.`), agent name (max 9 cells, clipped with
  `…`), the agent definition's model as the short `Provider/Model` label, an
  agent with no defined model shows blank model cells.
- Idle state: grey (`theme.text.muted`), empty boxes.
- Working state: the colour defined on the agent definition, falling back to
  the theme's success green.

## R3 — Instance rows

One instance row per running child session of that role, scoped to the tab
currently viewed (other tabs' sessions are invisible here).

- Indented under the role with tree glyphs `├` (more follow) and `└` (last).
  Unnumbered.
- Fields in order: session title (max 8 cells, clipped with `…`), model
  short label (max 12 cells via R5's split rule), context bar (5 boxes).
- Colour: same rule as the working role row.
- A succeeded instance disappears immediately: its row collapses back into
  the role row. A failed or interrupted instance does not — it follows
  R4's grace window before the row collapses.

## R4 — Failure grace window

A session that ended with `outcome: failed` or `interrupted` keeps its
instance row for 30 seconds in warning colour, then folds back into its role
row.

- The warning colour overrides the agent definition colour while it lasts.
- The role row shows warning too while every instance of that role is inside
  the window and none is working.
- Expiry is time-based: a one-second ticker runs only while a grace row is
  inside its window, and stops afterwards.

## R5 — Layout arithmetic

Both row shapes are exactly `width` cells wide; the boxes always occupy the
last 5 columns, aligned across rows.

- `width` option, default 35 cells.
- Model label rule: when `Provider/Model` overflows its field, the provider
  keeps at most half of it, and the model name gets whatever remains; the
  whole label clips to `field - 1` characters plus `…`.
- Role field: number 3 + name 9 + space 1 + model (width - 19, capped at 20)
  + gap 1 + boxes 5.
- Instance field: indent 3 (space, glyph, space) + title 8 + space 1 + model
  12 + padding to align + gap 1 + boxes 5.
- `One constant, one meaning`: each field has its own named constant; one
  constant never serves a second field.

## R6 — Context bar

- `filled = round(pct × 5 / 100)`, clamped 0-5.
- Fill colours: success under 50%, warning 50-69%, error 70% or more,
  independent of the row text colour. Unknown usage: empty muted boxes.
- `pct = (input + cache.read) of the newest message that reports tokens`
  divided by the model's `limit.context`. Cumulative session tokens are
  never used (they do not fall after compaction).
- A working role row's box mirrors its busiest instance's fill; idle roles
  show empty boxes.

## R7 — Team ordering and overflow

Order: roles with instances first (oldest-instance-first between roles,
oldest-first inside a role), then idle roles alphabetically. Anything beyond
the 10-line body folds into one muted line `+N more · /subagents`. A role is
never separated from its instance rows; overflow counts whole sections.

## R8 — Model resolution

Per session, in order, first hit wins:

1. the session's own model,
2. the agent definition's model,
3. the nearest ancestor session's model,
4. `unknown model`.

An instance may therefore legitimately show a model different from its
role's definition. Theme fallbacks: missing provider name shows the provider
ID; the short label uses the provider's last word (`OpenCode Go` → `Go`) and
drops the variant.

## R9 — Subagent picker

`/subagents` (alias `/subagent-models`) lists running subagents only:
agent, resolved model (full label, clipped at 96), title, elapsed time,
session ID. Slash arguments pre-filter the picker (`/subagents explore`
filters by "explore" on open). Type-to-filter across those fields. Enter
opens the session; `alt+o` opens without closing the picker. Optional
keybind via `bind`.

## R10 — Palette commands

- `Show running subagent models` — opens the picker.
- `Toggle compact subagent status` — toggles compact between sessions,
  persisted, toast feedback, hidden when the config forces `compact`.

## R11 — Failure-free

Plugin errors surface as host toasts, never as missing rows: an exception in
panel building must not leave the sidebar blank.

## R12 — Verification

- Coder: unit tests in `src/lib/collect.test.ts` pin every contract number
  in this document with boundary fixtures on both sides (fits / does not
  fit).
- Code-reviewer: runs the unit suite, and re-checks fixtures before
  reporting either a clean state or findings.
