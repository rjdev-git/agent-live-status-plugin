# Product — subagent-live-status-plugin

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
  `N` = roles with a working instance (including a temporarily working
  built-in under R2's charter-mode exception); `M` = roles known — in
  charter mode the `.opencode/agents` definitions only, so `M` is stable for
  the whole session even as temporary built-in rows appear and vanish; in
  built-in mode the counted built-in agents.
- Placement: `sidebar.content` by default; `sidebar.footer` and
  `prompt.footer` selectable.
- Body: maximum 10 lines, excluding the title and the overflow line.
- `compact` mode replaces the panel with the single line `sub N`
  (N = running subagent count).

## R2 — Role rows

One row per subagent-capable agent of the panel's active member set. Member
selection is human decision A.8:

- The panel picks its mode once, as a snapshot at session start (or plugin
  activation): **charter mode** when at least one agent definition file
  exists in `.opencode/agents`, else **built-in mode**. Mid-session changes
  to `.opencode/agents` do not flip the mode until the next session.
- Built-in mode: rows are the host's built-in agents, excluding agents
  marked `hidden` and primary agents. They show idle rows the same as any
  role.
- Charter mode: rows are the `.opencode/agents` definitions only. Built-in
  agents get no idle row, even though their definitions exist in the host.
- Charter-mode exception: while a task dispatched to a built-in agent has at
  least one child session in flight, that built-in gets a temporary role row
  under the R3/R4 lifecycle. When no session of it remains, the row
  disappears entirely.
- A built-in agent's role row shows no model label (human decision A.9):
  where member rows show the definition's short model label, a built-in row
  — temporary in charter mode, permanent in built-in mode — instead carries
  a `[built-in]` tag beside the role name. Instance rows of a built-in keep
  their model label and never carry the tag.

Rows carry:

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
  short label (max 12 cells via R5's split rule), speed bar (5 boxes, R6).
  The model label renders only when it carries information (human decision
  A.10): when the instance's resolved model differs from the role's own
  resolved model, or when the instance's model is unknown. When the labels
  agree, the model cell is omitted. How the row lays out when the field is
  absent is a design decision; the comparison itself is done on the
  resolved labels before any clipping.
- Colour: same rule as the working role row.
- A succeeded instance disappears immediately: its row collapses back into
  the role row. A failed or interrupted instance does not — it follows
  R4's grace window before the row collapses. For a temporary built-in row
  (R2, charter-mode exception) the collapse of the last instance removes the
  role row too.

## R4 — Failure grace window

A session that ended with `outcome: failed` or `interrupted` keeps its
instance row for 30 seconds in warning colour, then folds back into its role
row.

- The warning colour overrides the agent definition colour while it lasts.
- The role row shows warning too while every instance of that role is inside
  the window and none is working.
- Expiry is time-based: a one-second ticker runs only while a grace row is
  inside its window, and stops afterwards.
- The window applies to every instance row, including instances of a
  temporary built-in row (R2): a failed or interrupted built-in instance
  keeps its row in warning colour for the same 30 seconds before the built-in
  row disappears entirely.

## R5 — Layout arithmetic

Both row shapes are exactly `width` cells wide; the boxes always occupy the
last 5 columns, aligned across rows.

- `width` option, default 35 cells.
- Dynamic width (human decision A.11): the panel derives its row width from
  the host's reactive sidebar width in CSS pixels divided by the `cellPx`
  option (default 8), rounded. The configured `width` stays as the fallback
  when detection is unavailable and as the cap when detection succeeds — the
  panel is never wider than the `width` option. Detection is unavailable
  while the host reports no width (not loaded, sidebar closed/transitioning,
  or the panel not rendered in the side region); then the configured `width`
  governs, floor `MIN_ROW_CELLS` as before.
- Proportional fields (A.11): on a role row the "rest" (width − 3 number − 1
  gap − 1 separator − 5 boxes) splits between the name field and the model
  field — name gets 40% rounded, model gets the remainder. On an instance
  row the same rest splits between the title field and the model field, but
  the title field stays capped at its 8-cell maximum (any unused title
  cells go to the model field). Name/title floor 6 cells, model field floor
  4 cells; whenever a floor binds (or detection is unavailable), the
  previous fixed-field arithmetic governs instead.
- Fixed under A.11: the two-digit number (3 cells), both gap/separator
  cells (1 each), the 5 speed boxes, and the `[built-in]` tag — the tag
  keeps its fixed 10-cell rendering inside whatever model field the split
  yields, it is never proportional.
- Model label rule: when `Provider/Model` overflows its field, the provider
  keeps at most half of it, and the model name gets whatever remains; the
  whole label clips to `field - 1` characters plus `…`.
- Exactly one separator cell sits between the model field and the first
  box glyph on both row shapes (A.5; between box glyphs there is none).
- Role field: number 3 + name 9 + space 1 + model (width - 19, capped at 20)
  + separator 1 + boxes 5. At the default width the model field is 16 cells.
- Instance field: indent 3 (space, glyph, space) + title 8 + space 1 + model
  12 + padding to align + separator 1 + boxes 5.
- `One constant, one meaning`: each field has its own named constant; one
  constant never serves a second field.

## R6 — Speed bar (context bar removed by human decision A.3)

The 5 boxes show the instance's live output speed, not context usage.

- Fill is banded (human decisions A.6 and A.7): 5 boxes above 100 tokens/sec
  (strictly greater than 100, so 100.0 exactly stays in the 4-box band),
  4 at 70–100, 3 at 50–69.9, 2 at 20–49.9, 1 at 5–19.9, none below 5. The
  bands compress the range so slow flash models and fast agents both read
  visibly.
- All filled boxes use the theme's success green. No warning ramp — speed
  has no pressure semantics. Unknown speed: empty muted boxes.
- Speed = output tokens produced divided by the wall time producing them,
  measured over the instance's observed streaming messages, recomputed when
  a new message arrives or on the 1-second ticker. The exact arithmetic
  over the available message timestamps is a design decision and must be
  flagged for arbitration if the data cannot support it.
- A working role row's box mirrors its busiest active instance's fill; idle
  roles show empty boxes.
- Features removed with the context bar: the token-percentage calculation,
  the 50/70 colour bands, and every rule that needed `limit.context`. The
  G16 sync requirement survives untouched — messages still feed the boxes.

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
  persisted, toast feedback, disabled (but still shown in the palette) when
  the config forces `compact`.

## R11 — Failure-free

Plugin errors surface as host toasts, never as missing rows: an exception in
panel building must not leave the sidebar blank.

## R12 — Verification

- Coder: unit tests in `src/lib/collect.test.ts` pin every contract number
  in this document with boundary fixtures on both sides (fits / does not
  fit).
- Code-reviewer: runs the unit suite, and re-checks fixtures before
  reporting either a clean state or findings.
