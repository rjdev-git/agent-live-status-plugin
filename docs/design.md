# Design — opencode-subagent-model

Binding design for R1–R12 of `docs/Product.md`. `docs/Product.md` is the
contract; this document is how the contract is realised. Precedence:
`docs/Product.md` > this document > code. Requirement sections restate the
contract numbers; §6 is the single place where those numbers are bound to
named constants and to test fixtures.

Implementation split:

| Layer | File | Owns |
| --- | --- | --- |
| pure view model | `src/lib/collect.ts` | role/instance selection, ordering, model resolution, clipping, bar arithmetic, grace state, numbering, overflow |
| TUI | `src/tui.tsx` | host sources, theme colours, glyph rendering, 1 s ticker, slots, commands, picker, error guard |
| bootstrap | `src/index.ts` | plugin registration only |

Nothing in `collect.ts` may import the TUI SDK: every contract number must be
testable from plain data.

## 0. Vocabulary and invariants

- **Cell** — one terminal column. A normal code point is 1 cell, an East
  Asian Wide/Fullwidth code point is 2 cells, a combining mark is 0 cells.
  Every clip and pad in this document is measured in cells, not in UTF-16
  code units. The ellipsis `…` is 1 cell.
- **Role** — one entry of the visible subagent set (R2): the host's agent
  list, minus `hidden` agents, minus `mode: "primary"` agents.
- **Instance** — one child session that belongs to a visible role and is
  either running (**active**) or inside the failure grace window (**grace**).
- **Body** — the role and instance lines under the title. The title and the
  overflow line are not body lines.
- **Speed (`tps`)** — output tokens per second of one instance, computed from
  its own assistant messages only (§2, R6). Finite and non-negative or
  unknown; never a percentage, never derived from `limit.context`.
- **View** — the pure output of `panel()`:

  ```ts
  {
    rows: Array<{ head: string; filled: number; tps?: number;
                  state: "idle" | "active" | "grace"; agentColor?: string }>
    more: number        // folded body lines
    working: number     // roles with an active instance
    total: number       // visible roles
  }
  ```

  `head` is the whole row except the bar and is exactly `width - 5` cells.
  `filled` is 0–5. `tps` is the speed the fill was derived from; a role row
  carries the busiest **active** instance's speed, an idle role row carries
  `undefined`, and a grace row carries `undefined` because a finished session
  has no live speed (F18).
- The panel renders while `total > 0`; at `total = 0` the slot renders
  nothing.

## R1 — Always-visible team panel

Sidebar team panel, visible whenever the host knows at least one
subagent-capable agent (the R2 set; see F7).

- Title: `Project Team Members N/M` in the theme's base (white) colour.
  `N` = roles with a working instance (`view.working`); `M` = roles known
  (`view.total`).
- Placement: `sidebar.content` by default; `sidebar.footer` and
  `prompt.footer` selectable. Any other configured value falls back to
  `sidebar.content`.
- Body: maximum 10 lines, excluding the title and the overflow line.
- `compact` mode replaces the title + body + overflow with the single line
  `sub N`, where N = running subagent count in the panel's scope. Compact is
  rendered whenever `total > 0`; it is not an additional line.

Rendered height: `1 + rows.length + (more > 0 ? 1 : 0)` lines in full mode,
`1` line in compact mode. R1 fixes a colour for the title ("the theme's base
(white) colour") and R2/R4 fix row colours, but no requirement names a colour
for the compact line `sub N`. The design's choice is raised as F15; it is not
settled here.

## R2 — Role rows

One row per subagent-capable agent: builtin agents plus project agent
definitions (`context.data.location.agent.list(location)`), excluding agents
marked `hidden` and primary agents (`mode === "primary"`; `mode` undefined
behaves like `subagent`; `mode: "all"` is not primary and is included).

- Row: two-digit number (` 1.`, `20.`), agent name (max 9 cells, clipped with
  `…`), the agent definition's model as the short `Provider/Model` label, an
  agent with no defined model shows blank model cells.
- Idle state: grey (`theme.text.muted`), empty boxes.
- Working state: the colour defined on the agent definition, falling back to
  the theme's success green.

Role display name is `agent.name ?? agent.id`, clipped to 9 cells and padded
to 9. A role row's model column is blank (spaces) when
`agent.model` is undefined; otherwise the label is the short label (R8) of
`agent.model`, clipped by the R5 split rule. `view.total` counts the rows
that survive the R2 filter, including rows folded by overflow.

## R3 — Instance rows

One instance row per running child session of that role, scoped to the tab
currently viewed (other tabs' sessions are invisible here).

- Indented under the role with tree glyphs `├` (more follow) and `└` (last).
  Unnumbered.
- Fields in order: session title (max 8 cells, clipped with `…`), model
  short label (max 12 cells via R5's split rule), speed bar (5 boxes, R6).
- Colour: same rule as the working role row.
- A succeeded instance disappears immediately: its row collapses back into
  the role row. A failed or interrupted instance does not: it follows R4's
  grace window before its row collapses.

Rules:

- Scope is the root session family of the session the slot is rendering
  (`sources.sessions.root(slotSessionID)`). A session belongs to the tab when
  its root equals that root. With no viewed session the instance set is
  empty, not "all tabs" (F11; G2).
- A child session is attributable only when `session.agent` names a visible
  role. Running children of hidden, primary, or unknown agents are invisible
  (there is no role row to nest them under).
- Title = `cleanTitle(session.title ?? session.id)` (whitespace collapsed to
  single spaces, trimmed), clipped to 8 cells, padded to 8.
- Instance model = R8 resolution for that session, rendered as the short
  label, clipped to 12 cells by the R5 split rule, then padded to the model
  column; one separator cell follows the column before the boxes.
- "Finished" means status is no longer `running`. A succeeded session has no
  row at any age. Failed and interrupted sessions are the R4 exception and
  keep a row only inside the window.

## R4 — Failure grace window

A session that ended with `outcome: failed` or `interrupted` keeps its
instance row for 30 seconds in warning colour, then folds back into its role
row.

- The warning colour overrides the agent definition colour while it lasts.
- The role row shows warning too while every instance of that role is inside
  the window and none is working.
- Expiry is time-based: a one-second ticker runs only while a grace row is
  inside its window, and stops afterwards.

Design decisions:

- End time = `session.time.updated`, falling back to `session.time.created`.
  If neither exists the window cannot be measured; the session produces no
  grace row (F8).
- The window is half-open: a row is inside the window when
  `0 <= now - ended < GRACE_MS`. At exactly 30 000 ms it is folded (F4).
- A session is **grace** when: not running, `outcome` is `failed` or
  `interrupted`, and the elapsed time is inside the window. A running session
  is always **active**, never grace. A succeeded or otherwise finished session
  is never grace: it produces no row (R3).
- Role state: **active** if at least one instance is active; otherwise
  **grace** if it has at least one instance (all of which are grace);
  otherwise **idle**.
- A role with one active and one grace instance is active: role text uses the
  agent colour, the grace instance keeps warning, the active instance keeps
  the agent colour.
- Grace role rows show empty boxes (no instance is working; F12). A grace
  instance row shows empty boxes too: a finished session has no live speed
  (F18).
- The ticker lives in the TUI, not in the pure layer: the layer receives
  `now` as a parameter. The UI starts one `setInterval` of `GRACE_TICK_MS`
  when a rendered row has `state === "grace"`, bumps a signal each tick, and
  clears the interval when no grace row remains.

## R5 — Layout arithmetic

Both row shapes are exactly `width` cells wide; the boxes always occupy the
last 5 columns, aligned across rows. Column `W − 5` of both shapes is the
separator cell, so `head` is `W − 5` cells and ends with that space.

- `width` option, default 35 cells.
- Model label rule: when `Provider/Model` overflows its field, the provider
  keeps at most half of it, and the model name gets whatever remains; the
  whole label clips to `field - 1` characters plus `…`.
- Role field: number 3 + name 9 + space 1 + model (width - 19, capped at 20)
  + separator 1 + boxes 5. At the default width the model field is 16 cells.
- Instance field: indent 3 (space, glyph, space) + title 8 + space 1 + model
  12 + padding to align + separator 1 + boxes 5.
- Exactly one separator cell sits between the model field and the boxes on
  both row shapes (`ROLE_BAR_GAP_CELLS`, `INSTANCE_BAR_GAP_CELLS`, A.5).
  Between the box glyphs there is no gap (R6). The separator is why the role
  column is `width - 19` and the instance column `width - 18`.
- `One constant, one meaning`: each field has its own named constant; one
  constant never serves a second field.

The cell-by-cell arithmetic is §1. The cap in "capped at 20" is applied to
the model **label text**; the model **column** stays `width - 19` so the row
is exactly `width` cells for widths above 39 as well (F1). The instance model
**text** is 12 cells at every width where the column allows it; above 35 the
extra column cells become padding (F21). Below 30 cells the instance model
text shrinks below 12 to keep the row exactly `width` (F1).

## R6 — Speed bar

- `filled = clamp(round(tps / 20), 0-5)`; `20` tokens/sec fill one box, so
  `TPS_PER_BOX = 20` (C18, C19).
- All filled boxes use the theme's success green. No warning ramp: speed has
  no pressure semantics. Unknown speed renders empty muted boxes.
- Speed = output tokens produced divided by the wall time producing them,
  measured over the instance's assistant messages (§2), recomputed when a new
  message arrives or on the 1-second ticker (G17).
- A working role row's box mirrors its busiest **active** instance's speed;
  idle roles show empty boxes.
- Removed with the context bar: the token percentage, the 50/70 colour bands,
  and every rule that needed `limit.context`. The G16 sync requirement
  survives untouched — messages still feed the boxes.

Design decisions:

- **Which messages count.** Only entries of the instance's own session
  `message.list(sessionID)` with `type === "assistant"`, a `tokens` object
  whose `output` is a finite number `>= 0`, and a measurable stream window:
  `time.created`, `time.streamed` and `time.completed` finite numbers,
  `time.completed > time.streamed`, `time.streamed >= time.created`.
  Ancestor and descendant sessions never contribute.
- **The formula.** For one counted message
  `ms = time.completed - time.streamed` and `tokens = tokens.output`; the
  instance's `tps = 1000 × Σ tokens / Σ ms`. `tokens.output` excludes
  `tokens.reasoning`, `tokens.input` and both cache counters.
- **Unknown.** `tps` is unknown when no message counts, when `Σ ms <= 0`, or
  when either sum is not finite. Unknown renders `filled = 0` with five muted
  boxes, never a guessed number. A message with a missing token count, a
  missing `time.streamed`/`time.completed`, or `completed <= streamed`
  contributes neither tokens nor time; it is skipped whole, so a session whose
  messages all lack timing stays unknown rather than reporting a zero.
- **No `now` input.** Speed depends only on message timestamps, never on the
  render clock: a not-yet-completed assistant message does not count (its
  `tokens.output` is not final, F22). The ticker is a recompute trigger, not a
  time input; with unchanged message data a tick yields the same fill.
- **Window.** Cumulative over every counted message since the session started
  (no reset, no rolling window): the pure layer keeps no per-instance state,
  and the cumulative streaming rate is stable to read.
- **Rounding.** Half-up (`floor(x + 0.5)`), matching JavaScript
  `Math.round` on non-negative values: `19 → 1`, `10 → 1`, `30 → 2`,
  `50 → 3`, `90 → 5` (C19). `10` therefore **fills** one box, not zero (F20).
- **Role row.** Role `tps` = the maximum `tps` among its **active** instances
  with known speed; its `filled` is computed from that value by the same
  formula. A role with no known speed, an idle role, and a grace-only role
  all render `tps === undefined`, `filled = 0`.
- **Colour.** `barTone(filled)` returns `"success"` for `filled > 0` and
  `"muted"` for `filled === 0`; the TUI maps those to
  `theme.text.feedback.success.base` and `theme.text.muted`. There is no
  warning or error bar colour anywhere (C21).
- **Glyph.** A bar is `BAR_GLYPH_FILLED.repeat(filled) +
  BAR_GLYPH_EMPTY.repeat(BAR_CELLS − filled)`: `▓` (U+2593) filled, `░`
  (U+2591) empty (C30, C31). Consecutive boxes are adjacent, with no gap cell
  and no space character inside the bar; any gap the eye perceives comes from
  the glyph's own advance, and the pinned pair advances flush. The only cell
  between the model field and the bar is the one separator cell of R5.
- A grace instance keeps its row text in warning colour (R4) but its boxes
  are empty muted, like a grace role row (F18).

## R7 — Team ordering and overflow

Order: roles with instances first (oldest-instance-first between roles,
oldest-first inside a role), then idle roles alphabetically. Anything beyond
the 10-line body folds into one muted line `+N more · /subagents`. A role is
never separated from its instance rows; overflow counts whole sections.

The full algorithm is §4. Design decisions for the points Product leaves
open:

- A grace instance is an instance for ordering, so a grace-only role is a
  "role with instances" and is ordered with active roles by its oldest
  instance (F2). It is not a third tier.
- Between roles: smallest known `time.created` of that role's instances
  ascending; missing timestamps sort last; ties break on role display name
  (case-insensitive ascending), then id.
- Inside a role: `time.created` ascending, missing last, ties break on
  session id ascending.
- Idle roles sort by display name, case-insensitive ascending, then id.
- Overflow stops at the first section that does not fit. That section and
  every later section fold; `more` counts their body lines. A later small
  section is never pulled in ahead of a folded earlier one (F5). A single
  section larger than the body (for example one role with more instances
  than the cap allows) folds whole, and `more` counts all of its lines.
- `+N more · /subagents`: `N` = folded body lines, `·` is U+00B7 with one
  space on each side, the whole line is muted. The overflow line does not
  count against the 10-line body.
- Numbering: emitted role rows are numbered sequentially in print order
  (` 1.` …). Folded roles consume no number. Instance rows are unnumbered.
- `view.working` counts every role with an active instance, folded or not.

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

Algorithm:

```
resolve(session):
  if session.model                 -> session.model
  if agent(session.agent).model    -> that model
  walk session.parentID through sessions.get(); first ancestor with .model wins;
    stop at a missing parent; a visited set breaks cycles
  otherwise                        -> UNKNOWN_MODEL ("unknown model")
```

Labels:

- Full: `ProviderName/ModelName` plus ` (variant)` when the ref carries a
  variant. Provider name = provider list name, else the provider ID. Model
  name = model list `name` for `providerID + modelID` (or `+ id`), else the
  model id.
- Short: provider's last whitespace-separated word, no variant.
- A ref that does not resolve to a model entry still labels from its ids; a
  session that resolves to no ref labels `unknown model`.
- Role rows do not use session resolution: they show `agent.model` or blanks
  (R2). Instance rows use `resolve()`. `unknown model` as an instance label
  is clipped by R5, not blanked.

## R9 — Subagent picker

`/subagents` (alias `/subagent-models`) lists running subagents only: agent,
resolved model (full label, clipped at 96), title, elapsed time, session ID.
Type-to-filter across those fields. Slash arguments pre-filter the picker.
Enter opens the session; `alt+o` opens without closing the picker. Optional
keybind via `bind`.

Design decisions:

- The picker is global: all running child sessions, not scoped to the viewed
  tab (F9). It uses the same running-child predicate as R3 without the scope
  filter.
- Fields: title line `agent · model`; the model label clips at 96 cells
  (`PICKER_MODEL_CELLS`) and the agent clips at 24 cells
  (`PICKER_AGENT_CELLS`) by the §1.3 `clip` rule. The budgets are
  independent: the agent never consumes model budget (G12). Description
  `title · elapsed`; footer = session ID.
- Filter: trimmed, case-insensitive substring across agent, full model,
  title, elapsed text, and session ID; empty query matches everything.
- Elapsed: `< 60 s` → `Ns`; `< 60 min` → `Nm`; otherwise `Hh Mm`. Unknown
  start time renders empty.
- Slash command accepts arguments: `/subagents explore` opens the picker
  pre-filtered by `explore` (R9, F14). The argument is the picker's initial
  filter query on the same trimmed, case-insensitive substring rule as
  type-to-filter.
- Enter resolves the selected session and opens it; `alt+o` opens the
  session and leaves the picker open (G4).
- Open behaviour: focus the tab when it is a root session, otherwise
  navigate the router to the session.
- No running row: an alert, not an empty picker.

## R10 — Palette commands

- `Show running subagent models` — opens the picker.
- `Toggle compact subagent status` — toggles compact between sessions,
  persisted, toast feedback, hidden when the config forces `compact`.

Design decisions:

- Persistence: plugin storage under `opencode-subagent-model`, shape
  `{ compact: boolean }`, initial `{ compact: false }`.
- Effective compact = configured `compact` when it is a boolean, else the
  stored flag.
- The toggle command is registered only when the configured `compact` is not
  a boolean (config forces the mode, including `compact: false`, which pins
  full mode; F10). It flips the stored flag and shows
  `Subagent status: compact` or `Subagent status: full`.
- The show command carries the optional `bind` keybind; both commands are
  palette entries in the `Subagents` group.

## R11 — Failure-free

Plugin errors surface as host toasts, never as missing rows: an exception in
panel building must not leave the sidebar blank.

Design:

- The TUI wraps source reads, view building, and row rendering in a guard.
- On a thrown error: show one host toast with the error message (deduplicated
  per message while the same failure repeats), and render the last good view.
  If no good view exists yet, render the single muted line
  `subagent status unavailable` so the slot is never blank.
- A subsequent successful build replaces the fallback and clears the
  remembered failure.
- An unparseable agent colour is data, not a plugin error: fall back to the
  theme's success green silently.
- The pure layer stays total where it can: missing lists, missing sessions,
  cycles, missing usage, and missing limits return empty/undefined instead of
  throwing.

## R12 — Verification

- Coder: unit tests in `src/lib/collect.test.ts` pin every contract number
  in this document with boundary fixtures on both sides (fits / does not
  fit).
- Code-reviewer: runs the unit suite, and re-checks fixtures before
  reporting either a clean state or findings.

The testable surface is the pure layer: `panel`, `clip`, `fitModel`,
`speedTps` (returns tokens per second or `undefined`), `barFill` (returns
0–`BAR_CELLS`), `barTone` (returns `"success" | "muted"`), `resolve`/`modelRef`,
`labeler`, `elapsed`, `filterRows`. Theme mapping must be expressed through a
pure state/tone result so the colour rules of R2/R4/R6 are testable without the
SDK.

---

## 1. Panel layout arithmetic

All positions are 1-based columns. `W` is the effective width; `W >= 19`
(F1). At `W` below 19 the configured width is raised to 19 before layout.

Box glyphs (C30, C31) each advance one cell. The A.4 glyph swap changes no
column, no sum, and no width in this section: `BAR_CELLS` stays 5 and the
literals alone moved. A.5 restores the one-cell separator before the bar, so
§1.1 and §1.2 carry recomputed columns; the glyphs stay as A.4 left them.

### 1.1 Role row

| Columns | Cells | Field | Constant |
| --- | --- | --- | --- |
| 1–3 | 3 | number: two digits + `.` (` 1.`, `10.`) | `ROLE_NUMBER_CELLS` |
| 4–12 | 9 | agent name, clipped with `…`, padded | `ROLE_NAME_CELLS` |
| 13 | 1 | space between name and model | `ROLE_NAME_GAP_CELLS` |
| 14–(W−6) | W−19 | model column: label clipped to `min(W−19, 20)` cells, padded to the column | `ROLE_FIXED_CELLS`, `ROLE_MODEL_MAX_CELLS` |
| W−5 | 1 | separator before the boxes | `ROLE_BAR_GAP_CELLS` |
| W−4–W | 5 | speed boxes (tight between glyphs) | `BAR_CELLS` |

Head length = `3 + 9 + 1 + (W−19) + 1 = W − 5`; plus 5 boxes = `W`.

At `W = 35`: number 3, name 9, space 1, model column 16 (cap 20 not reached),
separator 1, boxes 5. `3 + 9 + 1 + 16 + 1 + 5 = 35`.
Example: ` 1.explore   Go/Kimi K3.1 Pro ` + 5 boxes: the 16-cell label fills
the 16-cell column exactly and the separator is the cell between the label and
the boxes.
A role with no `agent.model`: the model column is 16 spaces plus the 1-cell
separator.

### 1.2 Instance row

| Columns | Cells | Field | Constant |
| --- | --- | --- | --- |
| 1–3 | 3 | indent: space, glyph (`├` or `└`), space | `INSTANCE_INDENT_CELLS` |
| 4–11 | 8 | session title, clipped with `…`, padded | `INSTANCE_TITLE_CELLS` |
| 12 | 1 | space between title and model | `INSTANCE_TITLE_GAP_CELLS` |
| 13–(W−6) | W−18 | model column: label clipped to `min(W−18, 12)`, padded to the column | `INSTANCE_FIXED_CELLS`, `INSTANCE_MODEL_CELLS` |
| W−5 | 1 | separator before the boxes | `INSTANCE_BAR_GAP_CELLS` |
| W−4–W | 5 | speed boxes (tight between glyphs) | `BAR_CELLS` |

Head length = `3 + 8 + 1 + (W−18) + 1 = W − 5`; plus 5 boxes = `W`.

At `W = 35`: indent 3, title 8, space 1, model column 17 (12 text cells + 5
padding), separator 1, boxes 5. `3 + 8 + 1 + 17 + 1 + 5 = 35`. The title field
is always 8 cells even when the row is narrow; the model text shrinks below 12
only when the column itself is narrower than 12 (`W < 30`).

Both shapes put the separator in column `W − 5`, so the last model cell and the
bar align across role and instance rows.

### 1.3 Model label split rule

Input: a full or short label `P/M…` and a budget `B` cells.

0. If `B < 3` a split cannot fit both sides, so return `clip(label, B)`.
1. If `cellWidth(label) <= B`, return the label unchanged.
2. If the label has no `/`, return `clip(label, B)`.
3. Provider share `S = floor(B / 2)`. Provider text is `clip(P, S − 1)`, so
   provider text plus the `/` never exceeds `S` cells.
4. Model budget = `B − cellWidth(providerText) − 1`; model text is
   `clip(M…, modelBudget)`.
5. Result = `providerText + "/" + modelText`; its cell width never exceeds
   `B`.

`clip(text, n)`: empty when `n <= 0`; unchanged when the text fits; `…` when
`n == 1`; otherwise the widest prefix with `prefix + 1 <= n` cells plus `…`.
Padding to a column is always spaces.

The role label budget is `min(W−19, 20)`; the instance label budget is
`min(W−18, 12)`. The picker label uses a plain `clip(label,
PICKER_MODEL_CELLS)` — the split rule is not applied there (R9) — and the
picker agent uses `clip(agent, PICKER_AGENT_CELLS)` with the same `clip` rule
(§1.3, C24, C28, F16).

## 2. Data flow

One recompute per watched event (including a message content update) and per
grace tick. The plugin stores no session state; every field is derived from a
host source at render time.

| Source | Provides | Feeds |
| --- | --- | --- |
| `context.data.location.agent.list(location)` | id, name, model, mode, hidden, color | visible role set, `M`, role names, role colours, role model column |
| `context.data.session.list()` | child sessions: id, parentID, agent, model, title, outcome, time | instance set, attribution to a role, title, grace eligibility |
| `context.data.session.get(id)` | one session by id | ancestor walk for R8; session open |
| `context.data.session.root(id)` | root session id | tab scope (R3) |
| `context.data.session.status(id)` | `running` / `idle` | active vs not |
| `context.data.session.message.list(id)` | assistant messages with optional `tokens` (`output`, `input`, `reasoning`, `cache`) and `time.created` / `time.streamed?` / `time.completed?` | `tps` numerator and denominator (chain below) |
| `context.data.session.sync(id)`, `context.data.session.message.sync(id)` | loads one session / its messages into the TUI data cache | populates `session.list`/`session.get` and `message.list` before they are read (G16) |
| `context.data.location.model.list(location)` | model id, modelID, providerID, name | model display names only; `limit.context` is no longer read |
| `context.data.location.provider.list(location)` | provider id, name | provider display names / short label last word |
| `context.theme` | `text.base`, `text.muted`, `text.feedback.success/warning.base` | title, idle/active/grace text, filled boxes (success), empty boxes (muted) |
| `context.storage.store("opencode-subagent-model")` | persisted `{ compact }` | R10 |
| slot input `sessionID` | viewed session id | R3 tab scope; compact count scope |
| `context.ui.router.current()` | current route | session context for opening a picked session; not used to scope the picker (F9) |
| host events (`session.created/deleted/moved/forked/renamed/status/idle/agent.selected/model.selected/execution.started/succeeded/failed/interrupted`, plus `session.step.ended` and `session.message.content.updated`) | invalidation; on `session.created` and `session.execution.started` also a sync trigger, on `session.step.ended` a message re-sync trigger (known-fire: final `tokens` per completed assistant step), on `session.message.content.updated` a second re-sync trigger (delivery unverified; G16) | bump the view signal; load the instance session then its messages; re-read messages when an assistant step ends |
| 1 s ticker | clock while a grace row exists; doubles as a recompute trigger for `tps` (R6) | recompute `now` for grace expiry and re-run `panel()` |

Location: the location the TUI is showing (`context.location`, else
`context.data.location.default()`). The plugin never merges agent definitions
from disk; the host's agent list is authoritative.

`tps` chain: `message.list(sessionID)` of the instance's own session → keep
assistant messages that pass the §R6 filter → `tokens = Σ tokens.output`,
`ms = Σ (time.completed − time.streamed)` → `tps = 1000 × tokens / ms`.
Nothing else feeds the bar: no model limit, no context window, no token
percentage. `model.list` is read for labels only.

Data availability: `message.list(id)` reads the data layer's cache, which the
client fills only for sessions it has synchronised. The code now syncs before
it reads (`syncSession`, `src/tui.tsx:92-108`) on the touchpoints it already
collects:

- `session.execution.started` or `session.created` for a child session with a
  visible role → `context.data.session.sync(sessionID)` first, then
  `context.data.session.message.sync(sessionID)` once the session is loaded.
- `session.step.ended` for an instance session → re-sync its messages
  (`resyncMessages`, same call site) so the final `tokens.output` of each
  completed assistant step reaches the cache before the next `panel()` pass.
  This is the **known-fire** trigger: the event is a typed `V2Event` member and
  fires per completed assistant step with
  `data: { sessionID, assistantMessageID, tokens }` (G16).
- `session.message.content.updated` for an instance session → re-sync its
  messages on the same path. This trigger is **belt-and-braces**: the typed
  `on` map does not expose the event and its delivery to a plugin listener is
  unverified, so it is kept as a second net and `session.step.ended` is the
  trigger the design relies on (G16).
- Both re-sync paths bypass the once-per-session `syncedSessions` guard: that
  guard exists to stop repeated session loads, not to stop message refreshes.
- The sync is a host call with a side effect and lives in `src/tui.tsx`, not
  in the pure layer (R12); no cache entry is invalidated by hand.
- Sync failure is not a panel failure: it follows R11 (toast, last good view),
  and the affected row simply shows what is loaded.

Obsolete rule: F17's no-limit fallback rule is dead with A.3. No percentage
exists, so no `limit.context` is read, no fallback limit exists, and a model
missing from the catalog cannot blank the bar. The bar is unknown only when
the messages cannot yield a speed (§R6).

## 3. State rules and colours

| State | Predicate | Role text | Role boxes | Instance text | Instance boxes |
| --- | --- | --- | --- | --- | --- |
| idle | visible role with no active and no grace instance | `theme.text.muted` | empty (0 filled) | n/a | n/a |
| active | `status === "running"`, visible role, in scope | agent `color` (parsed), else `theme.text.feedback.success.base` | busiest active instance's fill, fill cells success green | agent `color`, else success | own fill, fill cells success green |
| grace | not running, `outcome` failed/interrupted, `0 <= now − ended < GRACE_MS` | `theme.text.feedback.warning.base` | empty (0 filled; F12) | warning, overrides agent colour | empty (0 filled; F18) |

- Empty boxes (the `5 − filled` remainder) are always `theme.text.muted`,
  independent of the row text (F13).
- Filled boxes are always `theme.text.feedback.success.base`; `barTone` has
  exactly two outcomes, `"success"` (filled > 0) and `"muted"` (filled = 0).
  There is no warning or error box colour (R6).
- Role state: active if any instance active; else grace if any instance;
  else idle.
- A finished succeeded session, an out-of-window failure, a running session
  of a hidden/primary/unknown agent, and any session in another tab produce
  no row.
- Title is `theme.text.base`; the overflow line is `theme.text.muted`.
- The panel is hidden at `total = 0`; compact is shown at `total > 0` and is
  the only line then.

## 4. Orderings and overflow

1. Build the visible role list and the instance sections per §2/R3/R4.
2. Split sections into **busy** (at least one active or grace instance) and
   **idle** (visible roles with no instance).
3. Sort busy sections by `min(created)` over their instances ascending;
   missing timestamps last; ties on role name (case-insensitive), then id.
4. Sort each section's instances by `created` ascending; missing last; ties
   on session id.
5. Sort idle roles by display name, case-insensitive ascending, then id.
6. Emit in order: each busy section as a role line followed by its instance
   lines (`├` for all but the last, `└` for the last), then one line per idle
   role.
7. A section is emitted only when `emitted + sectionLines <= BODY_MAX_LINES`.
   The first section that does not fit stops the body: it and every later
   section fold, and `more` is the sum of their body lines. (A busy section
   is `1 + instances` lines; an idle section is 1 line.)
8. `more > 0` appends `+N more · /subagents` after the body, muted.
9. Emitted role lines are numbered `1..` in print order; instance lines stay
   unnumbered. `working` and `total` count all roles, folded or not.

## 5. Model resolution order

Already specified in R8. The single shared implementation must be used by the
instance rows, the picker, and the speed computation's message scope: each
instance's speed reads only that session's own messages. The role row uses
only the agent definition model (R2). Cycle protection is mandatory: a
parent chain that revisits a session stops the walk and falls through to
item 4.

## 6. Contract numbers

`cellWidth` follows §0. All fixtures are ASCII except the wide-cell cases in
C5 and C11, and the box glyphs in C30/C31 (`▓` U+2593, `░` U+2591), each of
which counts as one cell. Values are exact, not shapes; a fixture that
asserts only width or "contains" does not satisfy R12.

| # | Constant | Value | Field | Fits fixture | Does-not-fit fixture | Req |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | `BODY_MAX_LINES` | 10 | body lines, title and overflow excluded | 10 idle roles → 10 rows, `more = 0` | 11 idle roles → 10 rows, `more = 1` | R1, R7 |
| C2 | `DEFAULT_WIDTH` | 35 | row width when the option is absent | width unset → role head 30 cells + 5 boxes, instance head 30 + 5 | width 30 → role head 25, instance head 25 | R5 |
| C3 | `ROLE_NUMBER_DIGITS` | 2 | role number digits | role 9 → `" 9."`, role 10 → `"10."` | no emitted role index reaches 100 (body cap); the fixture asserts the highest emitted number is the tenth role | R2 |
| C4 | `ROLE_NUMBER_CELLS` | 3 | number field (2 digits + `.`) | first role: `head.slice(0,3) === " 1."` | tenth role: `head.slice(0,3) === "10."` (no leading space, still 3 cells) | R2, R5 |
| C5 | `ROLE_NAME_CELLS` | 9 | agent name field | `"explore"` → `"explore  "`; 9-cell `"123456789"` unchanged | `"1234567890"` → `"12345678…"`; wide `"调研团队组"` (5 wide code points = 10 cells) → `"调研团队…"` (4 wide code points = 8 cells + `…` = 9 cells) | R2, R5 |
| C6 | `ROLE_NAME_GAP_CELLS` | 1 | space after the name field | at width 35, `"explore"` + model `Go/Kimi K3.1 Pro` → head `" 1.explore   Go/Kimi K3.1 Pro "` (30 cells, 0-based `head[12] === " "`) | a gap-less implementation starts the model one cell early: its head is `" 1.explore  Go/Kimi K3.1 Pro  "` (30 cells, `head[12] === "G"`, model column 18), so the pinned string fails it | R5 |
| C7 | `ROLE_MODEL_MAX_CELLS` | 20 | role model label text cap | width 40 (column 21): `"Go/Kimi K3.1 Pro Max"` (20 cells) kept whole | width 40: `"Go/Kimi K3.1 Pro Maxx"` (21 cells) → `"Go/Kimi K3.1 Pro Ma…"` (20 cells) | R5 |
| C8 | `ROLE_FIXED_CELLS` | 19 | all row cells except the model column (3+9+1+1+5) | width 19 → model column 0, head 14; width 40 → model column 21, head 35 | width 18 → effective width raised to 19 (F1) | R5 |
| C9 | `BAR_CELLS` | 5 | boxes | `filled = 5` → 5 filled glyphs | `filled = 0` → 5 empty glyphs | R1, R3, R5, R6 |
| C10 | `INSTANCE_INDENT_CELLS` | 3 | indent (space, glyph, space) | first of two instances at width 35, title `Inspect modules`, model `Go/Grok 4.7`: head `" ├ Inspect… Go/Grok 4.7       "` (30 cells) | both directions fail: a not-last instance rendering `" └ Inspect… Go/Grok 4.7       "` (index 1 is `└`), and the last instance rendering `" ├ …"` instead of `" └ …"`; a 2-cell indent shifts the title left (`" ├I…"`) and fails `head.slice(0, 3) === " ├ "`. The fixture pins `├` on every instance except the last and `└` on the last | R3, R5 |
| C11 | `INSTANCE_TITLE_CELLS` | 8 | instance title field | `"Inspect modules"` → `"Inspect…"`; 8-cell title unchanged | 9-cell `"abcdefghi"` → `"abcdefg…"`; wide `"调研团队组"` (10 cells) → `"调研团…"` (7 cells: 6 + `…`) | R3, R5 |
| C12 | `INSTANCE_TITLE_GAP_CELLS` | 1 | space after the title field | 0-based `head[11] === " "` at width 35 | a 9-cell title is clipped to 8, so no title cell lands in the gap column | R5 |
| C13 | `INSTANCE_MODEL_CELLS` | 12 | instance model label text cap | width 35: `"Go/Kimi K3.1"` (12 cells) kept whole, so the column is 12 text + 5 padding | budget 12: `"OpenCode/Kimi K3.1 Pro"` (22 cells) → split `"Open…/Kimi …"` (12 cells); plain `clip` gives `"OpenCode/Ki…"` (12 cells), so the fixture discriminates the split rule | R3, R5 |
| C14 | `INSTANCE_FIXED_CELLS` | 18 | all row cells except the model column (3+8+1+1+5) | width 35 → model column 17 = 12 text + 5 padding | width 18 → effective width raised to 19, model column 1 (F1) | R5 |
| C15 | separator cell, tight glyphs | `ROLE_BAR_GAP_CELLS` = `INSTANCE_BAR_GAP_CELLS` = 1; 0 between box glyphs | the model column ends one cell before the boxes | width 35 role: `"Go/Grok 4.7"` (11 cells) leaves 5 pad cells in the 16-cell column, then the separator, so head `" 1.explore   Go/Grok 4.7      "` (30 cells) ends with 6 spaces; `"Go/Kimi K3.1 Pro"` (16 cells) fills the column and the separator is the 30th cell (`" 1.explore   Go/Kimi K3.1 Pro "`). Width 35 instance: `"Go/Kimi K3.1"` (12 cells) + 5 pad + 1 separator | width 35 role: `"Go/Grok 4.7 Flash"` (17 cells) → split `"Go/Grok 4.7 Fla…"` (16) and head `" 1.explore   Go/Grok 4.7 Fla… "` (30); the A.3 no-separator column of 17 keeps the label whole (`" 1.explore   Go/Grok 4.7 Flash"`, 30) and fails; a model field that eats the separator renders a 29-cell head (`" 1.explore   Go/Grok 4.7     "`) and fails the 6-space pin. Instance twin at 12 vs 13: `"Go/Grok 4.7.1"` (13) → `"Go/Grok 4.7…"` (12) and head `" ├ Inspect… Go/Grok 4.7…      "`; the 13-cell text under A.3 renders `" ├ Inspect… Go/Grok 4.7.1     "` | R5, R6 |
| C16 | `FILL_MIN_BOXES` | 0 | lower fill clamp | `tps = 0` → `filled = 0` | `tps = 9` → `filled = 0` (below half a box) | R6 |
| C17 | `FILL_MAX_BOXES` | 5 | upper fill clamp | `tps = 1000` → `filled = 5` (clamped, not 50) | `tps = 89` → `filled = 4` (clamp not reached) | R6 |
| C18 | `TPS_PER_BOX` | 20 | tokens/sec per filled box | `tps = 20` → `filled = 1` (exactly one box); `tps = 19` → `filled = 1` | `tps = 29` → `filled = 1` (needs 30 for two boxes) | R6 |
| C19 | fill formula | `floor(tps / TPS_PER_BOX + 0.5)` then clamp `FILL_MIN_BOXES`–`FILL_MAX_BOXES` | boxes filled | `tps 10 → 1`, `30 → 2`, `50 → 3`, `90 → 5` (half-up, so .5 rounds up) | `tps 9 → 0`, `29 → 1`, `89 → 4` | R6 |
| C20 | tps formula | `1000 × Σ tokens.output / Σ (time.completed − time.streamed)` over counted assistant messages | tokens per second | one assistant message, `output 200`, `streamed 1000`, `completed 2000` → `tps = 200`; two messages `100` over 1000 ms and `100` over 3000 ms → `50` (the average of the two per-message rates would give `66.67`) | same message without `time.completed`, or without `tokens`, or with `completed === streamed` → `undefined` → 0 boxes | R6 |
| C21 | `barTone` | `filled > 0` → `"success"`, else `"muted"` | box colour class | `tps 10` → 1 box → `"success"`; `tps 300` → 5 boxes → `"success"` | `tps 1000` (5 boxes) → never `"error"`; unknown speed → `"muted"`; no `filled` value returns `"warning"` or `"error"` | R6 |
| C22 | `GRACE_MS` | 30 000 | grace window | `now − ended = 29 999` → grace row | `now − ended = 30 000` → folded | R4 |
| C23 | `GRACE_TICK_MS` | 1 000 | ticker period | one tick moves `now` from 29 000 to 30 000, so the grace row folds | no grace row → no interval scheduled | R4 |
| C24 | `PICKER_MODEL_CELLS` | 96 | picker model clip | 96-cell full label kept | 97 cells → 95 cells + `…` | R9 |
| C25 | `ELLIPSIS_CELLS` | 1 | clip reservation | `clip("abcdef", 4) = "abc…"` | `clip("abc", 1) = "…"` | R5 |
| C26 | `PROVIDER_MAX_SHARE` | 1/2 of the field | provider share in the split rule | budget 15: `"Go/Kimi K3.1 Pro"` (16 cells) → `"Go/Kimi K3.1 P…"` (15 cells); provider `Go` (2 cells) is inside the 6-cell provider text cap | budget 15: `"SomeVeryBigName/Model"` → `"SomeV…/Model"` (provider text 6 cells + `/` = 7 = `floor(15/2)`) | R5 |
| C27 | `UNKNOWN_MODEL` | text `unknown model` | last resolution fallback | column 12 (width 30) → `"unknown mod…"` (12 cells; the 13-cell text clips to the 12-cell text cap) | column 11 (width 29) → `"unknown mo…"` (11 cells; the column binds); column 21 (width 39) is still `"unknown mod…"`, never the whole 13-cell text | R8 |
| C28 | `PICKER_AGENT_CELLS` | 24 | picker agent field | `"explore-deep-review-qa"` (22 cells) and `"explore-deep-review-qa12"` (24 cells) kept whole | `"explore-deep-review-qa123"` (25 cells) → `"explore-deep-review-qa1…"` (23 agent cells + `…`, 24 cells) | R9 |
| C29 | picker title budgets (independence rule) | agent ≤ `PICKER_AGENT_CELLS`, model ≤ `PICKER_MODEL_CELLS`; neither consumes the other | picker title `agent · model` | agent `"explore-deep-review-qa12"` (24 cells) with model `"m"` × 96 (96 cells) → all 24 agent cells and all 96 model cells render unclipped | agent `"explore-deep-review-qa123"` (25 cells) with the same 96-cell model → agent renders `"explore-deep-review-qa1…"` (24 cells) and the model still renders 96 cells, not 95 (an implementation subtracting the agent overflow from `PICKER_MODEL_CELLS` yields 95 and fails) | R9 |
| C30 | `BAR_GLYPH_FILLED` | `"▓"` (U+2593, 1 cell) | filled box glyph | `filled = 5` → `"▓▓▓▓▓"` (5 cells); a partially filled bar keeps the filled run leftmost | `filled = 0` → `""` (no filled glyph); the glyph is not U+25AE `▮` | R6 |
| C31 | `BAR_GLYPH_EMPTY` | `"░"` (U+2591, 1 cell) | empty box glyph | `filled = 0` → `"░░░░░"` (5 cells); `filled = 4` → `"▓▓▓▓░"` (5 cells) | `filled = 5` → `""` (no empty glyph); the glyph is not U+25AF `▯` | R6 |

One constant, one meaning, checked at the places the numbers collide:

- `BAR_CELLS` (glyphs rendered) and `FILL_MAX_BOXES` (upper fill clamp) are
  both 5 by construction, but they are different fields. The invariant
  `0 <= filled <= BAR_CELLS` is asserted, and `filled` is produced only by the
  C19 formula.
- `BAR_GLYPH_FILLED` and `BAR_GLYPH_EMPTY` are two constants for two fields
  (filled run, empty remainder). Neither may serve the other, and neither may
  be written as a bare literal at the call site (C30, C31).
- `ROLE_MODEL_MAX_CELLS` (20) caps the role **text**; the role **column** is
  `ROLE_FIXED_CELLS`'s complement (`width − 19`). Neither is used for the
  instance column, which has `INSTANCE_MODEL_CELLS` (12) and
  `INSTANCE_FIXED_CELLS` (18).
- `ROLE_BAR_GAP_CELLS` and `INSTANCE_BAR_GAP_CELLS` are two constants for two
  fields (role separator, instance separator). Both are 1 by construction, but
  neither may be replaced by the other, by `ROLE_NAME_GAP_CELLS`, or by a bare
  literal at the call site (C15). The separator belongs to `head` (its last
  cell), not to the bar: `head` is `W − 5` cells and the boxes are appended
  flush.

Fixtures for C1 that pin the section-stop rule (R7, §4, F5). Width 35;
sections built from roles and instances as stated.- Stop rule (discriminating): role `A` with 7 instances (8 body lines), then
  role `B` with 2 instances (3 lines, 8 + 3 > 10), then idle role `C`
  (1 line). Body = `A`'s 8 lines only, `more = 4`, no row for `B` or `C`.
  An implementation that skips the non-fitting section would emit `C`
  (9 lines) with `more = 3`.
- Fitting counterpart: role `A` with 7 instances (8 lines) plus 2 idle roles
  → body 10 lines, `more = 0`.
- Single oversized section folds whole: one role with 10 instances
  (11 lines) plus 1 idle role → no body row, `more = 12`, rendered height 2
  (title + overflow line).
- Five-instance role boundary: role with 5 instances (6 lines) plus 10 idle
  roles → body = 6 + 4 idle = 10 lines, `more = 6`.

C8 recomputation (width ladder), pinned — `ROLE_FIXED_CELLS = 19`, so the
role model column is `W − 19` and the head is `W − 5` at every width:

| W | model column | head cells | head + 5 boxes |
| --- | --- | --- | --- |
| 19 | 0 | 14 | 19 |
| 20 | 1 | 15 | 20 |
| 29 | 10 | 24 | 29 |
| 30 | 11 | 25 | 30 |
| 39 | 20 | 34 | 39 |
| 40 | 21 | 35 | 40 |

At `W = 19` the model column is empty (0 cells), so `clip(label, 0) = ""` and
the row is `3 + 9 + 1 + 0 + 1 + 5 = 19`; the floor `MIN_ROW_CELLS = 19` is
unchanged (F1). At `W = 40` the column is 21 but the label text stops at
`ROLE_MODEL_MAX_CELLS = 20` (C7). A width of 18 is raised to 19 before layout.

C5 recomputation (wide cells), pinned — `clip("调研团队组", 9)`:

- Input `"调研团队组"`, char by char: 调 2, 研 2, 团 2, 队 2, 组 2 — 5 wide code
  points, 10 cells.
- Widest prefix with `prefix + 1 <= 9` is 4 code points = 8 cells
  (`"调研团队"`); plus `…` (1 cell) = `"调研团队…"`, 9 cells. **This is the
  pinned fixture.** An implementation that emits `"调研团…"` (3 code points =
  6 cells + `…` = 7 cells) underfills the 9-cell budget and fails.
- C11's twin is the same 10-cell input at budget 8: the widest prefix with
  `prefix + 1 <= 8` is 3 code points = 6 cells, so `"调研团…"` (7 cells,
  6 + `…`), which is why the 8-cell title field pins the shorter string.
- The 16-cell form `"调研团队组团队组"` (8 wide code points = 16 cells) clips to
  the same 9-cell `"调研团队…"`; it is not the pinned input. A fixture that
  calls that string "10 cells" has miscounted it, and the input this row pins
  is the 5-code-point `"调研团队组"`.

C13 split-rule recomputation, both strings derived from §1.3 and pinned:

- Input `label = "OpenCode/Kimi K3.1 Pro"`, budget `B = 12`.
  `cellWidth(label) = 8 + 1 + 13 = 22 > 12`, and the label contains `/`.
- `S = floor(12 / 2) = 6`; provider text `clip("OpenCode", 5)` = widest prefix
  with `prefix + 1 <= 5` → `"Open"` (4 cells) → `"Open…"` (5 cells).
- Model budget `= 12 − 5 − 1 = 6`; `clip("Kimi K3.1 Pro", 6)` → widest prefix
  with `prefix + 1 <= 6` → `"Kimi "` (5 cells) → `"Kimi …"` (6 cells).
- Split result: `"Open…/Kimi …"`, `5 + 1 + 6 = 12` cells. **This is the
  pinned fixture.**
- Plain clipping of the same label: `clip(label, 12)` → widest prefix with
  `prefix + 1 <= 12` → `"OpenCode/Ki"` (11 cells) → `"OpenCode/Ki…"`
  (12 cells). The two strings differ, so the fixture fails an implementation
  that skips the split rule.
- **Coincidence at budget 12 — non-discriminating, must not be used as a
  fixture.** The retired example `"Go/MiniMax M3.1 Flash"` (21 cells) yields
  `"Go/MiniMax …"` under **both** rules:
  - Split: `S = floor(12 / 2) = 6`; `clip("Go", 5)` returns `"Go"` (2 cells,
    fits); model budget `= 12 − 2 − 1 = 9`; `clip("MiniMax M3.1 Flash",
    9)` → `"MiniMax "` (8 cells) + `…`; result `"Go/MiniMax …"` (12 cells).
  - Plain clip: `clip("Go/MiniMax M3.1 Flash", 12)` → `"Go/MiniMax "` (11
    cells) + `…` = `"Go/MiniMax …"` (12 cells).
  The two strings are identical, so this input cannot catch an implementation
  that skips the split rule. C13's discriminator is the pinned
  `"OpenCode/Kimi K3.1 Pro"` fixture above: `"Open…/Kimi …"` (split) against
  `"OpenCode/Ki…"` (plain clip).

C28 recomputation, pinned:

- Input `agent = "explore-deep-review-qa123"`, `cellWidth = 25 > 24`.
- Widest prefix with `prefix + 1 <= 24` → `"explore-deep-review-qa1"` (23
  cells) → `"explore-deep-review-qa1…"` (24 cells). An implementation that
  takes a 24-cell prefix and then appends `…` returns
  `"explore-deep-review-qa12…"` (25 cells) and fails.

C29 recomputation (independent budgets), pinned:

- Fits agent `"explore-deep-review-qa12"`, counted char by char under §0
  (every character narrow ASCII, 1 cell each): `explore` 7, `-` 8, `deep`
  12, `-` 13, `review` 19, `-` 20, `qa12` 24. `cellWidth = 24 =
  PICKER_AGENT_CELLS`, so `clip(agent, 24)` returns it unchanged.
- Fits model `"m"` repeated 96 times: 96 cells = `PICKER_MODEL_CELLS`, so
  the plain `clip(model, 96)` returns it unchanged. Both fields therefore
  survive whole: 24 agent cells and 96 model cells.
- Does-not-fit agent `"explore-deep-review-qa123"` = the 24-cell string plus
  `3` = 25 cells. `clip(agent, 24)` → widest prefix with `prefix + 1 <= 24`
  → `"explore-deep-review-qa1"` (23 cells) plus `…` (1 cell) =
  `"explore-deep-review-qa1…"` (24 cells).
- The model keeps its own budget: the same 96-cell `"m"` string renders 96
  cells. An implementation that computes the model budget as
  `96 − (25 − 24) = 95` renders 95 cells plus `…` and fails the fixture.

Additional exact-value fixtures that carry no number:

- Title `Project Team Members 1/5` for five visible roles and one active.
- Compact line `sub 3` for three running subagents in scope.
- Overflow line `+2 more · /subagents` exactly (U+00B7, one space each side).
- Role row at width 35 with `agent.model = Go/Kimi K3.1 Pro`:
  `" 1.explore   Go/Kimi K3.1 Pro "` + 5 boxes (head 30 cells:
  3 + 9 + 1 + 16 + 1; the 16-cell label fills the 16-cell model column
  exactly, and the last head cell is the separator space).
- Instance row at width 35, title `Inspect modules`, model `Go/Grok 4.7`:
  `" ├ Inspect… Go/Grok 4.7       "` + 5 boxes (head 30 cells:
  3 indent + 8 title + 1 gap + 17 model column + 1 separator; the 11-cell
  label leaves 6 pad cells in the 17-cell column, so the run after `4.7` is
  6 pad + 1 separator = 7 spaces).
- Speed bar glyphs at width 35, `filled = 3` (C19: `tps` 50–69): the role row
  `" 1.explore   Go/Kimi K3.1 Pro "` (30 cells) renders followed by `"▓▓▓░░"`,
  so the row is 35 cells; the bar follows the separator cell that ends the
  head, and no space sits inside the bar. `filled = 0` renders `"░░░░░"`;
  `filled = 5` renders `"▓▓▓▓▓"` (C30, C31).
- Separator discriminator at width 35 (C15): role label `"Go/Grok 4.7 Flash"`
  (17 cells) no longer fits the 16-cell column, so it becomes
  `"Go/Grok 4.7 Fla…"` and the head is `" 1.explore   Go/Grok 4.7 Fla… "`
  (30 cells, ending in the separator); an A.3 implementation with no separator
  and a 17-cell column keeps the label whole
  (`" 1.explore   Go/Grok 4.7 Flash"`, 30 cells). Instance twin: `"Go/Kimi
  K3.1"` (12 cells) fits the 17-cell column with 5 pad + 1 separator;
  `"Go/Grok 4.7.1"` (13 cells) becomes `"Go/Grok 4.7…"` (12 cells), where the
  A.3 budget of 13 keeps it whole.
- Role ordering: instances created at 20 and 10 → the 10 role first; inside a
  role, 10 before 30 with `├` then `└`.
- Idle ordering: `alpha`, `Zeta` → `alpha` before `Zeta`.
- A failed instance at 29 999 ms is `grace`; the same session at 30 000 ms
  is absent and its role may be idle.

## 7. Known gaps

Where the current code, read-only, disagrees with this design. Each gap is a
Coder task; findings and fixes reference these IDs. D1 is the one entry that is
not a gap: it registers a temporary diagnostic, with no contract number.

- **G1 (R11)** — No guard around source reads, view building, or colour
  parsing. An exception inside `sources()` or `panel()` leaves the slot
  blank; no toast is shown. `src/tui.tsx` view memo and slot render.
- **G2 (R3)** — When the slot provides no `sessionID`, `panel()` uses an
  undefined scope and includes running children of every tab. R3 requires an
  empty instance set when no tab is viewed (F11). `src/lib/collect.ts` scope
  block.
- **G3 (R9)** — The picker collects with `currentSessionID(context)`, so it
  hides running subagents from other tabs. R9 has no tab scope.
- **G4 (R9)** — The `alt+o` action calls `dialog.clear()` after opening the
  session, which closes the picker; R9 requires it to stay open.
- **G5 (R7)** — Grace-only sections are emitted after every active section
  instead of being ordered with instance-bearing roles by their oldest
  instance (F2). `panel()` active/grace buckets.
- **G6 (R3, R7)** — Instances inside a role are not sorted by
  `time.created`; the glyph and the oldest-first order follow the host's
  session list order.
- **G7 (R4)** — Grace eligibility uses `now − ended <= GRACE_MS`, so a row
  survives at exactly 30 000 ms; the design folds at 30 000 ms.
- **G8 (R6) — obsolete at A.3.** The pct clamp fix no longer exists: with the
  speed bar there is no percentage, no `PERCENT`, and no 100 cap. `contextPct`
  and its 117.1875 % fixture are deleted (G17). Nothing replaces this gap.
- **G9 (R5)** — Width arithmetic is derived from `min(20, width − 19)` with a
  floor of 4: rows are 39 cells for width > 39, wider than `width` for very
  narrow widths, and the old instance column (`budget + 1`) is one cell short
  at width > 39. The design uses `width − 19` (role) and `width − 18`
  (instance) columns, one separator cell before the boxes, the cap on the
  label **text**, and a floor of 19 (C7, C8, C13, C14, C15).
- **G10 (R5) — mostly obsolete; the width constants still move (G9).** The
  old claims are gone from the code: the instance column has its own
  `INSTANCE_FIXED_CELLS` / `INSTANCE_MODEL_CELLS`, the role cap has
  `ROLE_MODEL_MAX_CELLS`, and the former bare literals (`1000`, `96`, `10`,
  `35`) are named. What remains is A.5's separator move, which partially
  reverses A.3's layout move: `ROLE_FIXED_CELLS` 18 → 19,
  `INSTANCE_FIXED_CELLS` 17 → 18, `INSTANCE_MODEL_CELLS` 13 → 12, and
  `ROLE_BAR_GAP_CELLS = 1` / `INSTANCE_BAR_GAP_CELLS = 1` reinstated as two
  separate constants (`src/lib/collect.ts:255`, `:267`, `:270`; `roleHead`
  `:408-416`, `instanceHead` `:419-424`). `head` keeps its `W − 5` length and
  now ends with the separator cell; the TUI appends the boxes flush
  (`src/tui.tsx:319-321`). `MIN_ROW_CELLS = 19` stays the floor (F1). The
  60 / 1000 in `elapsed` are time units, not field widths.
- **G11 (R2, R3, R5)** — `truncate` counts UTF-16 code units, not display
  cells; wide characters and surrogate pairs misalign the boxes. The design
  measures cells (§0).
- **G12 (R9)** — The picker clips `agent · model` together at 96; the design
  clips the model label at `PICKER_MODEL_CELLS` and the agent separately at
  `PICKER_AGENT_CELLS`, with independent budgets (C28, C29).
- **G13 (R6)** — Working role rows never receive the busiest instance's
  metric, so their boxes render in the muted (unknown) colour. The wiring is
  unchanged in shape but carries a new metric: `panel()` must pass the
  busiest **active** instance's `tps` to the role row, not a `pct`
  (`src/lib/collect.ts:628-634`). `pct` is gone from `PanelRow` and from
  `RunningSubagent` (`:82`).
- **G14 (R4) — withdrawn at review.** The fallback `time.updated`, then
  `time.created`, and no grace row when neither exists, is already implemented
  (`src/lib/collect.ts:385-387`). No discrepancy; the remaining open point is
  the Product wording in F8.
- **G15 (R7)** — Overflow skips a non-fitting section and continues with
  later sections, which can show a lower-priority role after a folded
  higher-priority one. The design stops the body at the first non-fitting
  section (F5).
- **G16 (R6, §2 availability) — survives, re-scoped to speed; two triggers.**
  The sync path exists (`syncSession` / `resyncMessages`, `src/tui.tsx:92-108`)
  and loads the session, then its messages, then bumps the view. Its
  `syncedSessions` guard makes the session load once-per-session, so messages
  that arrive after the first sync never reach the cache and `tps` freezes at
  whatever the first load contained. The design keeps the same wiring and adds
  a message re-sync (no session re-sync, no new timer) on two triggers:
  `session.step.ended` — the typed `V2Event` member that fires per completed
  assistant step with final tokens
  (`data: { sessionID, assistantMessageID, tokens }`), so it is the
  **known-fire** trigger — and `session.message.content.updated` — kept as
  **belt-and-braces** because the typed map does not expose it and its delivery
  is unverified. `session.step.ended` is the trigger the design relies on.
  Both bypass the once-per-session guard. Host-call side effect: verified in
  review by inspection, not by a pure-layer fixture (R12).
- **G17 (R6)** — The speed computation does not exist. `lastUsage`
  (`src/lib/collect.ts:157-165`) and `contextPct` (`:167-179`) read the newest
  token report over `limit.context`; `contextLimit` (`:148-155`) finds the
  limit; `barFill` (`:454-458`) divides a percentage; `pushInstance` (`:607`)
  and the role aggregation (`:628-634`) pass `pct`. Required: a pure
  `speedTps(messages)` that keeps only counted assistant messages (§R6
  filter), returns `1000 × Σ tokens.output / Σ (completed − streamed)` or
  `undefined`; `barFill(tps)` = `clamp(floor(tps / TPS_PER_BOX + 0.5), 0, 5)`;
  `barTone(filled)` = `filled > 0 ? "success" : "muted"`.
  `contextLimit`, `contextPct`, `lastUsage`, `PERCENT`, `WARNING_MIN_PCT`,
  `ERROR_MIN_PCT`, `BAR_MIN_FILL`, `row.pct` and `RunningSubagent.pct` are
  deleted. Recompute triggers: any watched host event (already bumps the
  signal), `session.step.ended` and `session.message.content.updated` after
  their re-sync (G16), and the
  existing 1 s ticker (`src/tui.tsx:198-202`) while it runs — speed itself
  never reads `now`, so a tick without new message data is a no-op.
- **G18 (R6)** — Box colour is a three-band ramp: `barColor`
  (`src/tui.tsx:120-132`) maps `barBand(pct)` to success/warning/error and
  `:228` passes `row.pct`. Required: colour from `barTone(row.filled)` alone —
  filled cells `theme.text.feedback.success.base`, empty cells
  `theme.text.muted`, no warning or error path. The row **text** keeps its
  existing state colours (idle muted, grace warning, agent colour), which is
  a separate field.
- **G19 (R6)** — The box literals are `FILL = "▮"` (U+25AE) and
  `EMPTY = "▯"` (U+25AF) (`src/tui.tsx:26-27`). Required: `BAR_GLYPH_FILLED =
  "▓"` (U+2593) and `BAR_GLYPH_EMPTY = "░"` (U+2591), one constant each, no
  other literal. Nothing else in the bar changes: `BAR_CELLS` stays 5, the
  arithmetic and colours are untouched (C30, C31, A.4).
- **D1 debug option (temporary diagnostic, not in the contract).** The plugin
  accepts `debug: true` or `debug: "<path>"` and appends one JSONL record per
  recompute to `/tmp/opencode/subagent-model-debug.jsonl`; the string form
  overrides the path. It exists only for the current live-data investigation
  of R6's message timings (F19, G16), and it is removed once that
  investigation closes — the PM's commit message for this change names D1 and
  that removal. Not a C-row and no contract number: no requirement depends on
  it. With `debug` absent nothing is written and the dump path is never
  touched; a write failure is swallowed because it is a diagnostic, not a
  panel feature, so it cannot reach the R11 toast guard or change a row.
  `README.md` documents the option as temporary.

## 8. Findings for the Project Manager

Open points in `docs/Product.md` that this design resolves. None may be
settled by the Designer alone; the Project Manager takes them to the Analyst
(or the human) for the final wording. F3 and F14 are settled by Product
updates; F16 is settled (human decision A1); F17 is obsolete at A.3; F18–F22
are the new decisions A.3 forces; F23 is settled (human decision A.4); F24 is
settled (human decision A.5). F16, F17, F23 and F24 are listed with their
source rather than as requests for an answer.

- **F1 (R5 width domain).** R5 gives no lower bound on `width`. Below 19 cells
  the role row cannot hold its fields; the design raises the effective width
  to 19. Above 39, "model (width - 19, capped at 20)" and "Both row shapes are
  exactly `width` cells wide" conflict if the cap is read as the column. The
  design reads the cap as the label **text** and keeps the role column at
  `width - 19`, which preserves "Both row shapes are exactly `width` cells
  wide" and "the boxes always occupy the last 5 columns" for every width ≥ 19.
  Consequence at the floor: at exactly 19 the model column is 0 cells, so the
  row is number + name + gap + separator + boxes (C8 ladder). Confirm.
- **F2 (R7 vs R4 ordering).** R7 says "roles with instances first". A
  grace-only role has instances (R4), but R4 makes grace a distinct colour
  state. The design orders grace-bearing roles with active roles by oldest
  instance; it does not create a third tier. Confirm.
- **F3 (R3 vs R4) — settled by the Product update (Analyst decision A.2).**
  R3 now reads: "A succeeded instance disappears immediately: its row collapses
  back into the role row. A failed or interrupted instance does not — it
  follows R4's grace window before the row collapses." The design implements
  exactly that; R4 is the only exception. No answer needed.
- **F4 (R4 boundary).** "For 30 seconds, then folds" does not say whether
  exactly 30 000 ms is shown. The design uses a half-open window and folds at
  exactly 30 000 ms. Confirm.
- **F5 (R7 overflow).** "Anything beyond the 10-line body folds" does not say
  whether a non-fitting section blocks later smaller sections, nor whether
  `N` in `+N more` counts lines or sections. The design stops the body at the
  first non-fitting section and counts body lines; the current code skips the
  non-fitting section and may pull in a later one. Confirm.
- **F6 (notation).** `N` is used for three different counts: working roles in
  the title, running subagents in compact, folded lines in overflow. The
  design names them `working`, running-subagent count, and `more`. Product
  may want distinct symbols. Confirm.
- **F7 (R1 vs R2 visibility).** R1 says the panel renders when the host knows
  at least one subagent-capable agent; R2 excludes hidden and primary agents.
  The design applies R1's predicate to the R2 set, so a host that knows only
  hidden/primary agents shows no panel. Confirm.
- **F8 (R4 timestamp).** R4 assumes an end time for the 30 s window but
  Product names no field. The design uses `time.updated`, then
  `time.created`, and shows no grace row when both are missing. The code
  already implements this fallback (`src/lib/collect.ts:385-387`); only the
  Product wording is open. Confirm.
- **F9 (R1 compact and R9 picker scope).** Neither requirement states a tab
  scope for the compact count or the picker. The design scopes the compact
  count like the panel (viewed tab) and makes the picker global (all running
  subagents). Confirm.
- **F10 (R10 toggle visibility).** "Hidden when the config forces `compact`"
  names only the compact case, but `compact: false` in config also pins the
  mode, so a persisted toggle could never take effect. The design hides the
  toggle whenever the config sets `compact` to any boolean. Confirm.
- **F11 (R3 no viewed session).** R3 scopes instance rows to "the tab
  currently viewed", but does not say what the panel shows when no tab is
  viewed. The design uses an empty instance set: no instance rows, every role
  idle. It never falls back to "all tabs". Confirm.
- **F12 (R4/R6 grace role boxes).** R6 gives role boxes only for working roles
  (busiest **active** instance's speed) and idle roles (empty). A role whose
  every instance is inside the grace window is neither. The design fills 0
  boxes for it. Confirm.
- **F13 (R6 remainder colour).** R6 names one fill colour (success green) and
  "empty muted boxes" for unknown speed, but not the colour of the unfilled
  cells in a partially filled bar. The design renders the `5 − filled`
  remainder in `theme.text.muted` on every row. Confirm.
- **F14 (R9 pre-filter) — settled by the Product update.** R9 (commit
  `27485fe`) now reads: “Slash arguments pre-filter the picker (`/subagents
  explore` filters by "explore" on open).” The design sets the command
  argument as the picker's initial filter query, on the same trimmed,
  case-insensitive substring rule as type-to-filter. No answer needed.
- **F15 (R1 compact line colour).** R1 names a colour only for the title line
  ("Title: `Project Team Members N/M` in the theme's base (white) colour") and
  leaves the compact line `sub N` without one; R2/R4/R6 give colours for rows,
  not for this line. The design renders the compact line in
  `theme.text.feedback.success.base`, the same green a working row falls back
  to. Confirm, or name the colour R1 intends.
- **F16 (R9 picker agent width) — arbitrated by the PM, human decision A1.**
  R9 names a 96-cell clip for the model label but no number for the agent
  field. The design adds `PICKER_AGENT_CELLS = 24` (C28): the agent clips to
  24 cells by the §1.3 rule and never counts against the 96-cell model budget.
  This is a settled design decision, not an open question; Product R9 does not
  need a number for it. Recorded here for traceability.
- **F17 (R6 no context limit) — obsolete at A.3.** R6 no longer uses
  `limit.context` at all: no percentage exists, so no fallback limit can be
  invented and no model-catalog miss can blank the bar. The bar is unknown
  only when the instance's assistant messages cannot yield a speed (C20). The
  old `contextPct` rule and its fixture are removed (G8, G17). No answer
  needed; recorded so the code change is traceable.
- **F18 (R4/R6 grace instance boxes).** R4 keeps the failed/interrupted row
  "in warning colour", and R6 gives box colours only for live speed. A grace
  instance is finished, so it has no live speed and R6 has no warning box
  colour. The design renders its boxes empty muted (0 filled), the parallel of
  F12's grace role row, and keeps only the row **text** in warning. Confirm.
- **F19 (R6 speed arithmetic) — arbitration needed.** R6 leaves the arithmetic
  to design and asks for a flag when the data cannot support it. The pinned
  formula is `1000 × Σ tokens.output / Σ (time.completed − time.streamed)` over
  the instance's counted assistant messages, using exactly these
  `SessionMessageAssistant` fields from
  `@opencode/client/dist/promise/generated/types.d.ts`: `type`
  (`"assistant"`), `tokens.output` (via `TokenUsageInfo`, `types.d.ts:75-83`),
  `time.created`, `time.streamed`, `time.completed` (`types.d.ts:3473-3499`).
  The types exist; the risk is semantic: `time.streamed` is undocumented, and
  the design reads it as the start of streaming. If it is a last-update
  marker instead, the duration is understated and `tps` overstated (a
  five-box bar at absurd speeds). Arbitration must confirm the field, or
  accept the one-term fallback `start = time.created`, which needs no other
  design change. No field is invented and no wall clock is substituted.
- **F20 (R6 rounding).** `round` does not say how a half is resolved. The
  design pins half-up (`floor(x + 0.5)`): `tps 10` fills one box, `50` fills
  three, `90` fills five (C19). A fixture expecting `10 → 0` is inconsistent
  with half-up; the does-not-fit boundary is `9 → 0` (C19). Confirm half-up,
  or name floor/half-even and the boundary fixtures move with it.
- **F21 (R5 instance model text above width 35).** R5 gives the role model a
  width-dependent field (`width - 19, capped at 20`) but the instance model a
  fixed `12` plus "padding to align". The design reads that literally: the
  instance text cap stays 12 at every width and the extra column cells are
  padding (C13, C14, C27). Confirm, or say the instance text grows with the
  column like the role's.
- **F22 (R4/R6 ticker and in-flight messages).** R6 says the speed is
  "recomputed when a new message arrives or on the 1-second ticker", but R4
  runs that ticker only while a grace row is inside its window. The design
  keeps R4's lifetime (one ticker, one period, no always-on timer) and treats
  a tick as a recompute trigger only: `tps` never reads `now`, so a tick
  without new message data changes nothing. A not-yet-completed assistant
  message does not count, because its `tokens.output` is not final. Confirm;
  an always-on ticker would contradict R4 and is not assumed.
- **F23 (R6 box glyphs) — settled by the human, decision A.4.** The box
  glyphs are `▓` (U+2593, filled) and `░` (U+2591, empty), replacing
  `▮`/`▯`, which carry side bearing in common terminal fonts and render with
  visible gaps between boxes. The choice is font-dependent, not a layout
  rule: on a font without U+2591/U+2593 coverage the terminal substitutes a
  fallback glyph, whose advance may differ, but no cell math changes — the
  layout still emits `BAR_CELLS` glyphs in the last 5 columns and relies on
  each rendering one cell (§1, C30, C31). If a font renders either glyph at
  two cells the row would overrun `width`; that is a font property, not a
  design change, and the pinned fixtures use the one-cell advance. Recorded
  as a settled decision, not an open question.
- **F24 (R5 separator cell) — settled by the human, decision A.5.** Exactly one
  separator cell sits between the model field and the boxes on both row
  shapes; the model column refunds that cell (`width − 19` role,
  `width − 18` instance), so both shapes stay exactly `width` cells and the
  boxes stay in the last 5 columns. This partially reverts A.3's "tight
  boxes": tight remains **between the box glyphs** (0 gap), and only the
  model→bar boundary gets the separator. The two separators are two constants
  for two fields (`ROLE_BAR_GAP_CELLS`, `INSTANCE_BAR_GAP_CELLS`, C15); the
  glyphs are unchanged (`▓`/`░`, A.4, F23). Recorded as a settled decision,
  not an open question.

## 9. Revision notes

- **A.4 glyph amendment.** Box glyphs `▮`/`▯` → `▓`/`░` (C30, C31, F23, G19).
  No arithmetic moved: `BAR_CELLS` stays 5, both rows stay `width` cells, and
  no §1 column changes. The design document previously named no glyph
  literal, so the only design text that moved is the new pinned pair, its
  fixtures, and the flush-adjacency sentence in §R6.
- **A.5 separator amendment.** Exactly one separator cell between the model
  field and the boxes on both row shapes (F24, C15). The model column refunds
  that cell: `ROLE_FIXED_CELLS` 18 → 19, `INSTANCE_FIXED_CELLS` 17 → 18,
  `INSTANCE_MODEL_CELLS` 13 → 12, and `ROLE_BAR_GAP_CELLS` /
  `INSTANCE_BAR_GAP_CELLS` restored at 1. This partially reverts A.3; tight
  stays between glyphs, and A.4's glyphs are unchanged. Rows stay `width`
  cells and `head` stays `W − 5`; the width-35 example strings, the C8 width
  ladder, the C13 split fixture (budget 12), the C26 budget (15) and the C27
  columns (12 at width 30, 11 at width 29) moved with it.
