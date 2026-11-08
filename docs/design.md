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
- **View** — the pure output of `panel()`:

  ```ts
  {
    rows: Array<{ head: string; filled: number; pct?: number;
                  state: "idle" | "active" | "grace"; agentColor?: string }>
    more: number        // folded body lines
    working: number     // roles with an active instance
    total: number       // visible roles
  }
  ```

  `head` is the whole row except the bar and is exactly `width - 5` cells.
  `filled` is 0–5. `pct` is the percentage the fill was derived from; a role
  row carries the busiest instance's percentage, an idle role row carries
  `undefined`.
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
  short label (max 12 cells via R5's split rule), context bar (5 boxes).
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
  column.
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
- Grace role rows show empty boxes (no instance is working; F12).
- The ticker lives in the TUI, not in the pure layer: the layer receives
  `now` as a parameter. The UI starts one `setInterval` of `GRACE_TICK_MS`
  when a rendered row has `state === "grace"`, bumps a signal each tick, and
  clears the interval when no grace row remains.

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

The cell-by-cell arithmetic is §1. The cap in "capped at 20" is applied to
the model **label text**; the model **column** stays `width - 19` so the row
is exactly `width` cells for widths above 39 as well (F1). Below 30 cells the
instance model text shrinks below 12 to keep the row exactly `width` (F1).

## R6 — Context bar

- `filled = round(pct × 5 / 100)`, clamped 0-5.
- Fill colours: success under 50%, warning 50-69%, error 70% or more,
  independent of the row text colour. Unknown usage: empty muted boxes.
- `pct = (input + cache.read) of the newest message that reports tokens`
  divided by the model's `limit.context`. Cumulative session tokens are
  never used (they do not fall after compaction).
- A working role row's box mirrors its busiest instance's fill; idle roles
  show empty boxes.

Design decisions:

- `pct` is not clamped: usage above the limit reports above 100 (G8). The
  **fill** is clamped to 0–5, so over-limit still renders five filled boxes.
- "Newest message that reports tokens": scan
  `sessions.message.list(sessionID)` from the end; the first entry with a
  `tokens` object wins. `used = tokens.input + (tokens.cache.read ?? 0)`.
  Non-finite or negative `used` is unknown. Missing usage, missing limit, or
  a non-positive limit is unknown.
- The limit comes from the model entry whose `providerID` matches the
  resolved ref and whose `modelID` or `id` equals the ref id.
- Unknown usage renders `filled = 0` and muted boxes; there is no colour band
  for unknown.
- Role row `pct` = the maximum `pct` among its instances with known usage
  (the busiest). Its `filled` = the maximum fill. A role with no known usage
  has `pct === undefined`.
- Fill colour is derived from `pct` alone, never from the row text colour.
- A resolved model with no `limit.context` in the catalog leaves `pct`
  unknown: empty muted boxes, the same rendering as unknown usage. There is no
  invented fallback limit (F17, §2).

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
`barFill` (returns 0–`BAR_CELLS`), `barBand` (returns `"muted" | "success" |
"warning" | "error"`), `contextPct`, `resolve`/`modelRef`, `labeler`,
`elapsed`, `filterRows`. Theme mapping must be expressed through a pure
state/band result so the colour rules of R2/R4/R6 are testable without the
SDK.

---

## 1. Panel layout arithmetic

All positions are 1-based columns. `W` is the effective width; `W >= 19`
(F1). At `W` below 19 the configured width is raised to 19 before layout.

### 1.1 Role row

| Columns | Cells | Field | Constant |
| --- | --- | --- | --- |
| 1–3 | 3 | number: two digits + `.` (` 1.`, `10.`) | `ROLE_NUMBER_CELLS` |
| 4–12 | 9 | agent name, clipped with `…`, padded | `ROLE_NAME_CELLS` |
| 13 | 1 | space between name and model | `ROLE_NAME_GAP_CELLS` |
| 14–(W−6) | W−19 | model column: label clipped to `min(W−19, 20)` cells, padded to the column | `ROLE_FIXED_CELLS`, `ROLE_MODEL_MAX_CELLS` |
| W−5 | 1 | gap before the bar | `ROLE_BAR_GAP_CELLS` |
| W−4–W | 5 | context boxes | `BAR_CELLS` |

Head length = `3 + 9 + 1 + (W−19) + 1 = W − 5`; plus 5 boxes = `W`.

At `W = 35`: number 3, name 9, space 1, model column 16, gap 1, boxes 5.
Example: ` 1.explore   Go/Kimi K3.1 Pro ▮▮▮▯▯`.
A role with no `agent.model`: the model column is 16 spaces.

### 1.2 Instance row

| Columns | Cells | Field | Constant |
| --- | --- | --- | --- |
| 1–3 | 3 | indent: space, glyph (`├` or `└`), space | `INSTANCE_INDENT_CELLS` |
| 4–11 | 8 | session title, clipped with `…`, padded | `INSTANCE_TITLE_CELLS` |
| 12 | 1 | space between title and model | `INSTANCE_TITLE_GAP_CELLS` |
| 13–(W−6) | W−18 | model column: label clipped to `min(W−18, 12)`, padded to the column | `INSTANCE_FIXED_CELLS`, `INSTANCE_MODEL_CELLS` |
| W−5 | 1 | gap before the bar | `INSTANCE_BAR_GAP_CELLS` |
| W−4–W | 5 | context boxes | `BAR_CELLS` |

Head length = `3 + 8 + 1 + (W−18) + 1 = W − 5`; plus 5 boxes = `W`.

At `W = 35`: indent 3, title 8, space 1, model column 17 (12 label cells +
5 padding), gap 1, boxes 5. The title field is always 8 cells even when the
row is narrow.

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
(§1.3, C28, F16).

## 2. Data flow

One recompute per watched event and per grace tick. The plugin stores no
session state; every field is derived from a host source at render time.

| Source | Provides | Feeds |
| --- | --- | --- |
| `context.data.location.agent.list(location)` | id, name, model, mode, hidden, color | visible role set, `M`, role names, role colours, role model column |
| `context.data.session.list()` | child sessions: id, parentID, agent, model, title, outcome, time | instance set, attribution to a role, title, grace eligibility |
| `context.data.session.get(id)` | one session by id | ancestor walk for R8; session open |
| `context.data.session.root(id)` | root session id | tab scope (R3) |
| `context.data.session.status(id)` | `running` / `idle` | active vs not |
| `context.data.session.message.list(id)` | messages with optional `tokens` | `pct` numerator (newest reporting message) |
| `context.data.session.sync(id)`, `context.data.session.message.sync(id)` | loads one session / its messages into the TUI data cache | populates `session.list`/`session.get` and `message.list` before they are read (G16) |
| `context.data.location.model.list(location)` | model id, modelID, providerID, name, `limit.context` | `pct` denominator, model display names |
| `context.data.location.provider.list(location)` | provider id, name | provider display names / short label last word |
| `context.theme` | `text.base`, `text.muted`, `text.feedback.success/warning/error.base` | title, idle/active/grace text, bar bands, empty boxes |
| `context.storage.store("opencode-subagent-model")` | persisted `{ compact }` | R10 |
| slot input `sessionID` | viewed session id | R3 tab scope; compact count scope |
| `context.ui.router.current()` | current route | session context for opening a picked session; not used to scope the picker (F9) |
| host events (`session.created/deleted/moved/forked/renamed/status/idle/agent.selected/model.selected/execution.started/succeeded/failed/interrupted`) | invalidation; on `session.created` and `session.execution.started` also a sync trigger (G16) | bump the view signal; load the instance session then its messages |
| 1 s ticker | clock while a grace row exists | recompute `now` for grace expiry |

Location: the location the TUI is showing (`context.location`, else
`context.data.location.default()`). The plugin never merges agent definitions
from disk; the host's agent list is authoritative.

`pct` chain: resolve the session's model ref (R8) → find `limit.context` by
provider + model id → find the newest message with `tokens` → `used = input +
cache.read` → `pct = used / limit × 100`. Either side missing → unknown.

Data availability: `message.list(id)` reads the data layer's cache, which the
client fills only for sessions it has synchronised. The current code never
calls `session.sync()` or `session.message.sync()`, so an instance session
usually has no loaded messages and `pct` stays unknown (G16). The plugin
therefore syncs before it reads, on the touchpoints it already collects:

- `session.execution.started` or `session.created` for a child session with a
  visible role → `context.data.session.sync(sessionID)` first, then
  `context.data.session.message.sync(sessionID)` once the session is loaded.
- The sync is a host call with a side effect and lives in `src/tui.tsx`, not
  in the pure layer (R12); no cache entry is invalidated by hand.
- Sync failure is not a panel failure: it follows R11 (toast, last good view),
  and the affected row simply shows what is loaded.

No-limit rule (F17): when the resolved model has no `limit.context` in the
catalog, `pct` stays unknown and the bar renders exactly like unknown usage —
empty muted boxes (R6). The plugin never invents a fallback limit (no provider
default, no nominal window, no `0`). The pure-layer `pct` semantics are
unchanged: `contextPct` still returns `undefined` when either side is missing.

## 3. State rules and colours

| State | Predicate | Role text | Role boxes | Instance text | Instance boxes |
| --- | --- | --- | --- | --- | --- |
| idle | visible role with no active and no grace instance | `theme.text.muted` | empty (0 filled) | n/a | n/a |
| active | `status === "running"`, visible role, in scope | agent `color` (parsed), else `theme.text.feedback.success.base` | busiest instance's fill and band | agent `color`, else success | own fill and band |
| grace | not running, `outcome` failed/interrupted, `0 <= now − ended < GRACE_MS` | `theme.text.feedback.warning.base` | empty (0 filled; F12) | warning, overrides agent colour | own fill and band |

- Empty boxes (the `5 − filled` remainder) are always `theme.text.muted`,
  independent of the row text (F13).
- Bar bands, from `pct` alone: `undefined` → muted; `< 50` → success;
  `< 70` → warning; `>= 70` → error.
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
instance rows, the picker, and the context percentage; the role row uses
only the agent definition model (R2). Cycle protection is mandatory: a
parent chain that revisits a session stops the walk and falls through to
item 4.

## 6. Contract numbers

`cellWidth` follows §0. All fixtures are ASCII except C5/C12 wide-cell
cases. Values are exact, not shapes; a fixture that asserts only width or
"contains" does not satisfy R12.

| # | Constant | Value | Field | Fits fixture | Does-not-fit fixture | Req |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | `BODY_MAX_LINES` | 10 | body lines, title and overflow excluded | 10 idle roles → 10 rows, `more = 0` | 11 idle roles → 10 rows, `more = 1` | R1, R7 |
| C2 | `DEFAULT_WIDTH` | 35 | row width when the option is absent | width unset → role head 30 cells + 5 boxes, instance head 30 + 5 | width 30 → role head 25, instance head 25 | R5 |
| C3 | `ROLE_NUMBER_DIGITS` | 2 | role number digits | role 9 → `" 9."`, role 10 → `"10."` | no emitted role index reaches 100 (body cap); the fixture asserts the highest emitted number is the tenth role | R2 |
| C4 | `ROLE_NUMBER_CELLS` | 3 | number field (2 digits + `.`) | first role: `head.slice(0,3) === " 1."` | tenth role: `head.slice(0,3) === "10."` (no leading space, still 3 cells) | R2, R5 |
| C5 | `ROLE_NAME_CELLS` | 9 | agent name field | `"explore"` → `"explore  "`; 9-cell `"123456789"` unchanged | `"1234567890"` → `"12345678…"`; wide `"调研团队组"` (10 cells) → `"调研团队…"` (9 cells) | R2, R5 |
| C6 | `ROLE_NAME_GAP_CELLS` | 1 | space after the name field | at width 35, 0-based `head[12] === " "` | a 10-cell name is clipped to 9, so no name cell lands in the gap column | R5 |
| C7 | `ROLE_MODEL_MAX_CELLS` | 20 | role model label text cap | width 39, 20-cell label kept | width 39, 21-cell label → 19 cells + `…` | R5 |
| C8 | `ROLE_FIXED_CELLS` | 19 | all row cells except the model column (3+9+1+1+5) | width 19 → model column 0, head 14 | width 18 → effective width raised to 19 (F1) | R5 |
| C9 | `ROLE_BAR_GAP_CELLS` | 1 | gap before role boxes | 0-based `head[width-6] === " "` (1-based column `W−5`) | boxes starting at `head.length` instead of `head.length+1` | R5 |
| C10 | `BAR_CELLS` | 5 | boxes | `filled = 5` → 5 filled glyphs | `filled = 0` → 5 empty glyphs | R1, R3, R5, R6 |
| C11 | `INSTANCE_INDENT_CELLS` | 3 | indent (space, glyph, space) | head starts `" ├ "` | non-last instance starts `" ├ "`, last `" └ "` | R3, R5 |
| C12 | `INSTANCE_TITLE_CELLS` | 8 | instance title field | `"Inspect modules"` → `"Inspect…"`; 8-cell title unchanged | 9-cell `"abcdefghi"` → `"abcdefg…"`; wide `"调研团队组"` (10 cells) → `"调研团…"` (7 cells: 6 + `…`) | R3, R5 |
| C13 | `INSTANCE_TITLE_GAP_CELLS` | 1 | space after the title field | 0-based `head[11] === " "` at width 35 | a 9-cell title is clipped to 8, so no title cell lands in the gap column | R5 |
| C14 | `INSTANCE_MODEL_CELLS` | 12 | instance model label text cap | width 35: `"Go/Grok 4.7"` (11 cells) + 1 pad in the 12-cell text field | budget 12: `"OpenCode/Kimi K3.1 Pro"` (22 cells) → split `"Open…/Kimi …"` (12 cells); plain `clip` of the whole label gives `"OpenCode/Ki…"` (12 cells), so the fixture discriminates the split rule | R3, R5 |
| C15 | `INSTANCE_BAR_GAP_CELLS` | 1 | gap before instance boxes | 0-based `head[width-6] === " "` (1-based column `W−5`) | boxes begin at `head.length` | R5 |
| C16 | `INSTANCE_FIXED_CELLS` | 18 | all row cells except the model column (3+8+1+1+5) | width 35 → model column 17 = 12 label cells + 5 padding | width 18 → effective width raised to 19, model column 1 (F1) | R5 |
| C17 | `PERCENT` | 100 | percentage scale | `pct = 100` → `filled = 5` | `pct = 0` → `filled = 0` | R6 |
| C18 | `BAR_MIN_FILL` | 0 | lower fill clamp | `pct = 0` → `filled = 0` | `pct = -1` → `filled = 0` (clamped, no negative repeat) | R6 |
| C19 | `WARNING_MIN_PCT` | 50 | warning band start | `pct = 50` → warning | `pct = 49.9` → success | R6 |
| C20 | `ERROR_MIN_PCT` | 70 | error band start | `pct = 70` → error | `pct = 69.9` → warning | R6 |
| C21 | `GRACE_MS` | 30 000 | grace window | `now − ended = 29 999` → grace row | `now − ended = 30 000` → folded | R4 |
| C22 | `GRACE_TICK_MS` | 1 000 | ticker period | one tick moves `now` from 29 000 to 30 000, so the grace row folds | no grace row → no interval scheduled | R4 |
| C23 | `PICKER_MODEL_CELLS` | 96 | picker model clip | 96-cell full label kept | 97 cells → 95 cells + `…` | R9 |
| C24 | `ELLIPSIS_CELLS` | 1 | clip reservation | `clip("abcdef", 4) = "abc…"` | `clip("abc", 1) = "…"` | R5 |
| C25 | `PROVIDER_MAX_SHARE` | 1/2 of the field | provider share in the split rule | budget 16: `"Go/MiniMax M3.1 Flash"` → `"Go/MiniMax M3.1…"` | budget 16: `"SomeVeryBigName/Model"` → `"SomeVe…/Model"` (provider 7 cells + `/`) | R5 |
| C26 | fill formula | `round(pct × 5 / 100)`, half up | boxes filled | `pct 10 → 1`, `50 → 3`, `70 → 4`, `90 → 5` | `pct 9.99 → 0`, `120 → 5` (clamp), `−1 → 0` | R6 |
| C27 | `UNKNOWN_MODEL` | text `unknown model` | last resolution fallback | session with no ref → `"unknown model"` | a cell budget ≥ 13 keeps it; 12 clips to `"unknown mod…"` | R8 |
| C28 | `PICKER_AGENT_CELLS` | 24 | picker agent field | `"explore-deep-review-qa"` (22 cells) and `"explore-deep-review-qa12"` (24 cells) kept whole | `"explore-deep-review-qa123"` (25 cells) → `"explore-deep-review-qa1…"` (23 agent cells + `…`, 24 cells) | R9 |
| C29 | picker title budgets (independence rule) | agent ≤ `PICKER_AGENT_CELLS`, model ≤ `PICKER_MODEL_CELLS`; neither consumes the other | picker title `agent · model` | agent `"explore-deep-review-qa12"` (24 cells) with model `"m"` × 96 (96 cells) → all 24 agent cells and all 96 model cells render unclipped | agent `"explore-deep-review-qa123"` (25 cells) with the same 96-cell model → agent renders `"explore-deep-review-qa1…"` (24 cells) and the model still renders 96 cells, not 95 (an implementation subtracting the agent overflow from `PICKER_MODEL_CELLS` yields 95 and fails) | R9 |

Fixtures for C1 that pin the section-stop rule (R7, §4, F5). Width 35;
sections built from roles and instances as stated.

- Stop rule (discriminating): role `A` with 7 instances (8 body lines), then
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

C14 split-rule recomputation, both strings derived from §1.3 and pinned:

- Input `label = "OpenCode/Kimi K3.1 Pro"`, budget `B = 12`.
  `cellWidth(label) = 8 + 1 + 13 = 22 > 12`, and the label contains `/`.
- `S = floor(12 / 2) = 6`; provider text `clip("OpenCode", 5)` = widest prefix
  with `prefix + 1 <= 5` → `"Open"` (4 cells) → `"Open…"` (5 cells).
- Model budget `= 12 − 5 − 1 = 6`; `clip("Kimi K3.1 Pro", 6)` → widest prefix
  with `prefix + 1 <= 6` → `"Kimi "` (5 cells) → `"Kimi …"` (6 cells).
- Split result: `"Open…/Kimi …"`, `5 + 1 + 6 = 12` cells. **This is the pinned
  fixture.**
- Plain clipping of the same label: `clip(label, 12)` → widest prefix with
  `prefix + 1 <= 12` → `"OpenCode/Ki"` (11 cells) → `"OpenCode/Ki…"`
  (12 cells). The two strings differ, so the fixture fails an implementation
  that skips the split rule.
- Non-discriminating input, kept only as a plain-clip coincidence note:
  `"Go/MiniMax M3.1 Flash"` at budget 12 also yields `"Go/MiniMax …"` under
  both rules; it must not be used as the C14 fixture.

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
  exactly, the last cell is the bar gap).
- Instance row at width 35, title `Inspect modules`, model `Go/Grok 4.7`:
  `" ├ Inspect… Go/Grok 4.7       "` + 5 boxes (head 30 cells:
  3 indent + 8 title + 1 gap + 17 model column + 1 bar gap; the 11-cell label
  leaves 6 pad cells in the column, so the run after `4.7` is 6 + 1 = 7
  spaces).
- Role ordering: instances created at 20 and 10 → the 10 role first; inside a
  role, 10 before 30 with `├` then `└`.
- Idle ordering: `alpha`, `Zeta` → `alpha` before `Zeta`.
- A failed instance at 29 999 ms is `grace`; the same session at 30 000 ms
  is absent and its role may be idle.

## 7. Known gaps

Where the current code, read-only, disagrees with this design. Each gap is a
Coder task; findings and fixes reference these IDs.

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
- **G8 (R6)** — `contextPct` clamps to 100; the design clamps only the fill.
  A 117.1875 % session must report 117.1875 and render five boxes.
- **G9 (R5)** — Width arithmetic is derived from `min(20, width − 19)` with a
  floor of 4: rows are 39 cells for width > 39, wider than `width` for very
  narrow widths, and the instance column (`budget + 1`) is one cell short at
  width > 39. The design uses `width − 19` / `width − 18` columns with the
  cap on text, and a floor of 19.
- **G10 (R5)** — Constant hygiene: the role model budget
  (`width − ROW_FIXED_CELLS`, capped at `MAX_MODEL_CELLS`) is reused without
  a constant of its own for the instance model column
  (`model.padEnd(budget + 1)`, `src/lib/collect.ts:449`), so one budget serves
  two fields. `MAX_ROWS = 20` and `MAX_MODEL_CELLS = 20` are separately named
  and are not a duplicate-meaning pair. Unnamed literals remain: `1000`
  (`src/tui.tsx:123`), `96` (`src/tui.tsx:197`), `10`
  (`src/tui.tsx:116`, `src/lib/collect.ts:355`), `35`
  (`src/lib/collect.ts:295`, `:354`). The design gives every field its own
  constant and no bare literal in those positions.
- **G11 (R2, R3, R5)** — `truncate` counts UTF-16 code units, not display
  cells; wide characters and surrogate pairs misalign the boxes. The design
  measures cells (§0).
- **G12 (R9)** — The picker clips `agent · model` together at 96; the design
  clips the model label at `PICKER_MODEL_CELLS` and the agent separately at
  `PICKER_AGENT_CELLS`, with independent budgets (C28, C29).
- **G13 (R6)** — Working role rows never receive `pct`, so their filled boxes
  render in the muted (unknown) colour instead of the success/warning/error
  band of the busiest instance. `panel()` role line must carry the busiest
  `pct`.
- **G14 (R4) — withdrawn at review.** The fallback `time.updated`, then
  `time.created`, and no grace row when neither exists, is already implemented
  (`src/lib/collect.ts:385-387`). No discrepancy; the remaining open point is
  the Product wording in F8.
- **G15 (R7)** — Overflow skips a non-fitting section and continues with
  later sections, which can show a lower-priority role after a folded
  higher-priority one. The design stops the body at the first non-fitting
  section (F5).
- **G16 (R6, §2 availability)** — Nothing syncs sessions into the TUI data
  cache: `src/tui.tsx:28-42` watches `session.execution.started` and
  `session.created` (and the other lifecycle events) only to bump a signal,
  `src/tui.tsx:70-78` passes `context.data.session` through, and
  `src/lib/collect.ts:154` then calls `sessions.message.list` on a cache that
  usually has no messages for an instance session. Result: `pct` is unknown,
  the bar never fills. The design syncs `context.data.session.sync(id)` then
  `context.data.session.message.sync(id)` on those touchpoints (§2, F17 keeps
  the no-limit rendering). Host-call side effect: verified in review by
  inspection, not by a pure-layer fixture (R12).

## 8. Findings for the Project Manager

Open points in `docs/Product.md` that this design resolves. None may be
settled by the Designer alone; the Project Manager takes them to the Analyst
(or the human) for the final wording. F3 and F14 are settled by the Product
update; F16 and F17 are already settled (human decision A1; design decision
recorded for traceability). Those four are listed with their source rather
than as requests for an answer.

- **F1 (R5 width domain).** R5 gives no lower bound on `width`. Below 19 cells
  the role row cannot hold its fields; the design raises the effective width
  to 19. Above 39, "model (width − 19, capped at 20)" and "both rows exactly
  `width` cells" conflict if the cap is read as the column. The design reads
  the cap as the label text and keeps the column at `width − 19`, which
  preserves "exactly width" and "boxes last 5" for every width ≥ 19. Confirm.
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
  (busiest instance's fill) and idle roles (empty). A role whose every
  instance is inside the grace window is neither. The design fills 0 boxes for
  it. Confirm.
- **F13 (R6 remainder colour).** R6 names the fill colour per band and "empty
  muted boxes" for unknown usage, but not the colour of the unfilled cells in a
  partially filled bar. The design renders the `5 − filled` remainder in
  `theme.text.muted` on every row. Confirm.
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
- **F17 (R6 no context limit) — design decision.** The pure layer
  (`contextPct`, `src/lib/collect.ts:167`) leaves `pct` unknown when the
  resolved model has no `limit.context` in the catalog, and the row renders
  empty muted boxes exactly like unknown usage (R6). No fallback limit is
  invented: not a provider default, not a nominal window, not `0`. Product R6
  is the source of the unknown-usage rule. Syncing the session/message cache
  (§2, G16) changes only availability, not these semantics.
