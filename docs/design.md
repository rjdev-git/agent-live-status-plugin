# Design — subagent-live-status-plugin

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
- **Role** — one entry of the panel's active **member set** (R2, A.8): in
  charter mode the visible `.opencode/agents` definitions, in built-in mode the
  visible host built-ins. A visible built-in with an in-scope instance under a
  charter member set is a **temporary role**; it is a role only while it has an
  instance (§2.1).
- **Built-in role** — a role whose id is in `BUILTIN_AGENT_IDS` (C32), in
  either mode. Its row shows no model label: the model slot holds the tag
  `[built-in]` (`BUILTIN_TAG_TEXT`, C33, C34, A.9). Built-in-ness is carried by
  the head text; it is not a row field.
- **Role baseline model** — the role's own resolved model for the A.10
  comparison: the section definition's `agent.model` (the snapshot member, or
  the live entry for a temporary built-in), rendered by the same short-label
  rule as an instance and mapped to `UNKNOWN_MODEL` when the definition has
  none. It is a comparison operand only: it never prints on a built-in row
  (A.9) and never takes the role field cap or the role column width (C35).
- **Instance** — one child session that belongs to a role, including a
  temporary role, and is either running (**active**) or inside the failure
  grace window (**grace**).
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
    working: number     // roles with an active instance (N), temporary roles included
    total: number       // roles known (M): member roles only
    mode: "charter" | "builtin"   // member-selection snapshot (A.8)
  }
  ```

  `head` is the whole row except the bar and is exactly `W - 5` cells, where
  `W` is the effective row width of §1.4 (the configured width, or the
  measured-and-capped width, A.11, A.12). Both layout paths keep that length, so
  nothing downstream of the head learns which path produced it.
  A role head is number, name, and either the model label or, for a built-in
  role, the tag (`BUILTIN_TAG_TEXT`); an instance head is indent, title, and
  the model label when A.10 shows it (the model-column cells stay in place as
  spaces when it is omitted, §1.2). No head carries both (A.9).
  `filled` is 0–5. `tps` is the speed the fill was derived from; a role row
  carries the busiest **active** instance's speed, an idle role row carries
  `undefined`, and a grace row carries `undefined` because a finished session
  has no live speed (F18).
- `total` is `M` (R1): the member-set size, fixed by the snapshot. `working`
  is `N`; it includes a temporarily working built-in while `total` does not, so
  `N` can exceed `M` (`2/1`: one member and one temporary role working, one
  member known) in charter mode (A.8).
- The panel renders while `total > 0`; at `total = 0` the slot renders
  nothing.

## R1 — Always-visible team panel

Sidebar team panel, visible whenever the host knows at least one
subagent-capable agent (the R2 member set; see F7).

- Title: `Project Team Members N/M` in the theme's base (white) colour.
  `N` = roles with a working instance (`view.working`), including a
  temporarily working built-in; `M` = roles known (`view.total`), the
  member-set size. In charter mode `M` is the visible `.opencode/agents`
  definitions only and is stable for the whole session while temporary
  built-in rows come and go (§2.1, A.8). A temporary built-in counts in `N`
  but not in `M`, so `N` can exceed `M` (`2/1`); that is valid and intended.
- Visibility follows `total`: a charter member set with no visible definition
  gives `0/0`, which renders nothing, even if a temporary built-in is running
  (F27). The panel never hides while `total > 0`.
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

One row per member role, plus a temporary row for a charter-mode builtin
while it has instances (A.8). Membership is a snapshot, not a live list: the
mode and the member roles are decided once per location on its first render
from `context.data.location.agent.list(location)` (§2.1). Every member is
filtered by the shared rule: not `hidden`, and `mode !== "primary"` (`mode`
undefined behaves like `subagent`; `mode: "all"` is not primary and is
included).

- **Charter mode** — chosen when the host list holds at least one non-builtin
  agent (C32). Member rows are the visible non-builtin definitions only.
  Builtin agents get no idle row, even though their definitions exist in the
  host.
- **Built-in mode** — chosen when the host list holds no non-builtin agent.
  Member rows are the visible builtin agents (`BUILTIN_AGENT_IDS`, C32).
- **Charter-mode exception** — a visible builtin that is not a member gets a
  temporary role row only while it has at least one in-scope instance (active
  or grace, §R3); the row disappears with its last instance (§R3/R4, §2.1).
  A non-builtin id absent from the snapshot never gets a row, running or not.
- **Built-in tag (A.9)** — a built-in role shows no model label. Its model
  slot carries `BUILTIN_TAG_TEXT` (`[built-in]`, 10 cells, C33) beside the
  role name, in both modes: temporary built-in rows under a charter member
  set and permanent built-in rows in built-in mode (C34). The tag replaces the
  role row's model field only: it holds even when the host resolves a
  definition model for that agent (R8 step 2 still serves instance
  resolution). A member row of a non-builtin agent keeps the existing model
  rule unchanged. An instance row of a built-in keeps its model label (shown
  per A.10) and never carries the tag (§5, A.9).
- Row: two-digit number (` 1.`, `20.`), agent name (dynamic path: the full
  proportional name field, clipped with `…` only beyond it; fallback path:
  max 9 cells, clipped with `…`), the agent definition's model as the short
  `Provider/Model` label, an agent with no defined model shows blank model
  cells. A built-in role row shows the tag in that slot instead (A.9).
- Idle state: grey (`theme.text.muted`), empty boxes. Only member rows can be
  idle; a temporary role is never idle.
- Working state: the colour defined on the agent definition, falling back to
  the theme's success green. A temporary row uses exactly this rule.

Role display name is `agent.name ?? agent.id`. On the fallback path it is
clipped to 9 cells and padded to 9; on the dynamic path (A.11, §1.1) the name
uses the **full** derived name field `N` (C48), clips with `…` only beyond
that field, and is padded to `N` — there is no 9-cell cap on that path (R2 as
amended, F31 settled). A role
row's model column is blank (spaces) when
`agent.model` is undefined; otherwise the label is the short label (R8) of
`agent.model`, clipped by the R5 split rule. For a built-in role the column
holds the tag instead and `agent.model` is never read for that row (C34);
the name clip is confined to the derived name field (`ROLE_NAME_CELLS` on the
fallback path, `N` on the dynamic path) and cannot consume the tag
slot (C5, C48, A.9). `view.total` counts the member
rows only, including rows folded by overflow; temporary rows never enter it.
Member `AgentInfo` values come from the snapshot, so a mid-session definition
change cannot move a member row; temporary rows read the live builtin
definition (name and colour; its model never reaches the role row, A.9) and
use the same clipping and fallbacks.

## R3 — Instance rows

One instance row per running child session of that role, scoped to the tab
currently viewed (other tabs' sessions are invisible here).

- Indented under the role with tree glyphs `├` (more follow) and `└` (last).
  Unnumbered.
- Fields in order: session title (max 8 cells, clipped with `…`), model
  short label (max 12 cells via R5's split rule, shown only when A.10 keeps
  it), speed bar (5 boxes, R6).
- Model cell (A.10): the model short label renders only when the instance's
  resolved label differs from the role's resolved baseline label, or when the
  instance's model is unknown and the role's is known. Both sides are resolved
  by R8's order and compared as short-label text **before** any clipping or
  padding (C35). When the labels agree the cell is omitted; the row keeps the
  same geometry and the model-column cells become spaces (C36, §1.2).
- Colour: same rule as the working role row. Omitting the cell changes no
  colour: the blank cells carry no text, and the bar keeps `barTone(filled)`.
- A succeeded instance disappears immediately: its row collapses back into
  the role row. A failed or interrupted instance does not: it follows R4's
  grace window before its row collapses. For a temporary builtin row (R2,
  A.8) the collapse of the last instance removes the role row too: a
  succeeded last instance removes both rows in the same pass, a failed or
  interrupted last instance removes both at the R4 boundary.

Rules:

- Scope is the root session family of the session the slot is rendering
  (`sources.sessions.root(slotSessionID)`). A session belongs to the tab when
  its root equals that root. With no viewed session the instance set is
  empty, not "all tabs" (F11; G2).
- A child session is attributable only when `session.agent` names a member
  role or, in charter mode, a visible builtin eligible for a temporary row
  (R2, §2.1). Running children of hidden, primary, unknown, or non-member
  non-builtin agents are invisible (there is no role row to nest them under).
- A temporary builtin row exists only while it has at least one in-scope
  instance; an out-of-scope instance cannot materialise it (otherwise the
  row would be an idle builtin row, which R2 forbids).
- Title = `cleanTitle(session.title ?? session.id)` (whitespace collapsed to
  single spaces, trimmed), clipped to the title field `T` (§1.2, A.11),
  padded to `T`. On the fallback path `T = 8` cells (`INSTANCE_TITLE_CELLS`).
- Instance model = R8 resolution for that session, rendered as the short
  label, clipped by the R5 split rule to the model text cap
  `min(M, INSTANCE_MODEL_CELLS)`, then padded to the model field `M` (A.11,
  §1.2); one separator cell follows the field before the boxes. A.10
  suppresses the label when it equals the role baseline label (C35); the
  padding and the separator are unchanged when it is suppressed (C36).
- Comparison operands (A.10). Instance side: R8's own-session model → agent
  definition model (live `agents` list, §5) → nearest ancestor model →
  `UNKNOWN_MODEL`. Role side: the section definition's `agent.model` — the
  snapshot member entry, or the live builtin entry for a temporary row —
  rendered by the same short-label rule, or `UNKNOWN_MODEL` when it has no
  model. For a temporary built-in role the role side is its live definition
  model; the tag on its role row (A.9) is never the comparison operand. Both
  sides map through one helper, so `unknown model` equals `unknown model` and
  the cell is omitted (C35; Product wording is recorded as F29).
- Recompute: the comparison is evaluated on every `panel()` pass and its
  result is never stored. A resolved instance label can change mid-session
  (session model selected, ancestor appears, live definition changes), so a
  row can gain or lose the model cell between passes with no grace, state, or
  timer side effect.
- The instance model text cap stays `min(M, INSTANCE_MODEL_CELLS)` whether the
  label is shown or not; suppression removes text, never width, and the title
  keeps its field `T` (§1.2, C11, C36).
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

A temporary builtin row (R2, A.8) follows the same window unchanged: a
failed or interrupted instance of it keeps warning text for exactly
`GRACE_MS`, and at the boundary the instance row and its temporary role row
disappear together. No extra timer, no extra state.

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

Both row shapes are exactly `W` cells wide; the boxes always occupy the
last 5 columns, aligned across rows. Column `W − 5` of both shapes is the
separator cell, so `head` is `W − 5` cells and ends with that space.

- `width` option, default 35 cells.
- Dynamic width (A.11, ladder at A.12, §1.4): the row width is derived at
  render time from the host's rendered environment, never from a per-install
  config constant. Three automatic rungs, first success wins: (1) the
  renderer's layout tree, read in terminal cells — authoritative, because the
  panel is laid out inside it; (2) the sidebar's pixel width divided by the
  runtime pixels-per-cell measured from the terminal's reported pixel
  resolution and the renderer's cell columns; (3) the same pixel width
  divided by the last-resort `CELL_PX = 8` (C37). The configured `width` is
  the **fallback** when no rung produces a value and the **cap** when any
  rung does; the floor `MIN_ROW_CELLS = 19` applies in both paths.
  Detection is unavailable when the ladder cannot run at all: the panel is
  not in the side region, the region is not visible or the sidebar is closed,
  the stored width has not loaded (`transition() === false`), the gui module
  could not be resolved at runtime (F38), or every width
  read is not a finite positive number. Individual rungs also skip without
  failing the ladder: an ambiguous layout read skips rung 1, an absent
  terminal pixel resolution skips rung 2, and the next rung decides.
- Proportional fields (A.11): the "rest" is the row minus number 3 (role) or
  indent 3 (instance), the gap 1, the separator 1 and the boxes 5 — `W − 10`
  on both shapes. On a role row `rest` splits into the name field
  `N = roundHalfUp(rest × 2/5)` and the model field `rest − N`. On an
  instance row it splits the same way, but the title field is
  `T = min(roundHalfUp(rest × 2/5), 8)` and the unused cells go to the model
  field `rest − T`. Floors: name/title 6, model field 4. When a floor binds,
  or detection is unavailable, the pre-A.11 fixed arithmetic below governs
  exactly.
- Fixed under A.11: the two-digit number 3, the indent 3, both separator
  cells 1 each, the 5 boxes, and the `[built-in]` tag, which keeps its
  10-cell render **inside** whatever role model field the split yields and is
  never proportional.
- Model label rule: when `Provider/Model` overflows its field, the provider
  keeps at most half of it, and the model name gets whatever remains; the
  whole label clips to `field - 1` characters plus `…`.
- **Fallback path (the pre-A.11 arithmetic, still the fixture baseline):**
  role field: number 3 + name 9 + space 1 + model (width - 19, capped at 20)
  + separator 1 + boxes 5. At the default width the model field is 16 cells.
  A built-in role row puts `BUILTIN_TAG_TEXT` in that same model slot, clipped
  to the field (C33, C34, C50): the arithmetic is unchanged, so no total
  width, instance field, or member column moves (A.9).
- Instance field (fallback path): indent 3 (space, glyph, space) + title 8 +
  space 1 + model 12 + padding to align + separator 1 + boxes 5. A.10's
  omitted model cell keeps this arithmetic: the label text becomes 0 cells
  (all padding), the title field stays 8 and the model field stays
  `width - 18`, so the separator and the boxes do not move (§1.2, C36).
- Exactly one separator cell sits between the model field and the boxes on
  both row shapes (`ROLE_BAR_GAP_CELLS`, `INSTANCE_BAR_GAP_CELLS`, A.5).
  Between the box glyphs there is no gap (R6). The separator is why the
  fallback role column is `width - 19` and the fallback instance column
  `width - 18`.
- `One constant, one meaning`: each field has its own named constant; one
  constant never serves a second field.

The cell-by-cell arithmetic is §1; the width derivation is §1.4. The cap in
"capped at 20" is applied to the model **label text**; the role model
**field** is `width - 19` on the fallback path and the split field `M` on the
proportional path, so the row is exactly `W` cells in both. When A.10 shows
it, the instance model **text** is `min(M, 12)` cells; the extra field cells
become padding (F21). A suppressed instance label occupies 0 text cells and
the whole field is padding (C36). The two paths can disagree at the same `W`
(the fallback role row at 35 is `" 1.explore   Go/Kimi K3.1 Pro "`, the
proportional one `" 1.explore    Go/Kimi K3.1 P… "`); that is A.11's
fallback/cap rule, recorded as F32.

## R6 — Speed bar

- Fill is banded (human decisions A.6 and A.7): 5 boxes above 100 tokens/sec
  (strictly greater, so 100.0 exactly stays in the 4-box band), 4 at 70–100,
  3 at 50–69.9, 2 at 20–49.9, 1 at 5–19.9, none below 5. The bands compress
  the range so slow flash models and fast agents both read visibly.
- The floors are one ordered constant,
  `FILL_BANDS = [5, 20, 50, 70, 100]` tokens/sec, ascending. Floors 1–4 are
  inclusive: each is reached when `tps >= floor`. Floor 5 is exclusive: the
  fifth box is added only when `tps > floor`. So
  `filled = clamp(#{b ∈ FILL_BANDS[0..3] : tps >= b} +
  (tps > FILL_BANDS[4] ? 1 : 0), FILL_MIN_BOXES, FILL_MAX_BOXES)` (C18, C19).
  Only comparisons touch `tps`: no threshold is rounded and `tps` is never
  rounded. `TPS_PER_BOX = 20` (A.3) is superseded and deleted.
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
- **Bands, not rounding.** `filled` counts the inclusive floors the speed
  reaches and adds the fifth box only strictly above the exclusive top floor,
  then clamps to `FILL_MIN_BOXES`–`FILL_MAX_BOXES` (C19). No step rounds: `tps`
  keeps the exact value `speedTps` returns (C20) and only its comparison with
  each floor decides a box, so `4.99 → 0`, `5 → 1`, `19.99 → 1`, `20 → 2`,
  `49.99 → 2`, `50 → 3`, `69.99 → 3`, `70 → 4`, `100 → 4`, `100.01 → 5`. A
  `tps` exactly on an inclusive floor (5, 20, 50, 70) takes that band; exactly
  on the exclusive top floor (100) stays in the 4-box band. Unknown speed
  keeps `filled = 0` with five muted boxes (the "Unknown" bullet above).
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
- A temporary builtin role (R2, A.8) is a busy section and sorts in the
  working group by its oldest instance start, then name/id — the same rule,
  not a new tier. It has no idle position because it has no idle state.
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
  is clipped by R5, not blanked; A.10 omits it only when the role baseline is
  also unknown (C35, F29).

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
- A.8 changes nothing here: the picker lists running subagent sessions only,
  so a running builtin already appears, and nothing idle is listed. It keeps
  `collect()`'s predicate and applies no member filter; the panel's member
  set and temporary rows are a sidebar concern only. The R9 references to R3
  stay true because R3's running-child predicate did not change, only the
  attribution to a role.
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
  persisted, toast feedback, disabled (still registered and shown in the
  palette) when the config forces `compact`.

Design decisions:

- Persistence: plugin storage under `subagent-live-status-plugin`, shape
  `{ compact: boolean }`, initial `{ compact: false }`.
- Effective compact = configured `compact` when it is a boolean, else the
  stored flag.
- The toggle command is always registered and is gated by its `enabled`
  predicate, `enabled = (configured compact is not a boolean)`
  (`src/tui.tsx:513-518`). So a config that forces the mode — including
  `compact: false`, which pins full mode — leaves the palette entry
  visible-but-disabled, not unregistered. This is exactly R10 as settled
  (Product: "disabled (but still shown in the palette)"); no open point
  remains. Why registration time: the command
  list is built once in `context.keymap.layer` at setup, while `enabled` is
  read per palette render, so gating at registration would freeze the state at
  activation; the disabled entry also explains the config pin instead of
  silently vanishing. When enabled it flips the stored flag and shows
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
`labeler`, `elapsed`, `filterRows`, and `memberSet` (§2.1, C32). Theme
mapping must be expressed through a pure state/tone result so the colour rules
of R2/R4/R6 are testable without the SDK.

---

## 1. Panel layout arithmetic

All positions are 1-based columns. `W` is the effective row width from §1.4:
on the fallback path the configured `width` raised to `MIN_ROW_CELLS`; on the
proportional path (A.11) the measured cell count from the A.12 ladder, capped
by the configured `width` and floored at `MIN_ROW_CELLS`. `W >= 19` always
(F1, F33).

Box glyphs (C30, C31) each advance one cell. The A.4 glyph swap changes no
column, no sum, and no width in this section: `BAR_CELLS` stays 5 and the
literals alone moved. A.5 restores the one-cell separator before the bar, so
§1.1 and §1.2 carry recomputed columns; the glyphs stay as A.4 left them.

### 1.1 Role row

**Fallback path (detection unavailable, or a floor binds): the pre-A.11
arithmetic, unchanged.**

| Columns | Cells | Field | Constant |
| --- | --- | --- | --- |
| 1–3 | 3 | number: two digits + `.` (` 1.`, `10.`) | `ROLE_NUMBER_CELLS` |
| 4–12 | 9 | agent name, clipped with `…`, padded | `ROLE_NAME_CELLS` |
| 13 | 1 | space between name and model | `ROLE_NAME_GAP_CELLS` |
| 14–(W−6) | W−19 | model column: label clipped to `min(W−19, 20)` cells, padded to the column; a built-in role row puts `BUILTIN_TAG_TEXT` here instead (C33, C34) | `ROLE_FIXED_CELLS`, `ROLE_MODEL_MAX_CELLS`, `BUILTIN_TAG_TEXT` |
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

Built-in role row (A.9). The proposed placement is accepted as-is: the tag
takes the existing model-field position, so no total width, instance column,
or member column changes. The slot holds the tag, never a model:

```
slot(built-in) = padCells(clip(BUILTIN_TAG_TEXT, W−19), W−19)
slot(member)   = agent.model ? padCells(fitModel(label, min(W−19, 20)), W−19)
                            : " ".repeat(W−19)
head           = number + paddedName + space + slot + separator
```

`BUILTIN_TAG_TEXT` is 10 cells, so on the fallback path the tag is whole
whenever `W−19 >= 10`
(`W >= 29`); below that the ordinary `clip` rule applies (`min` with
`ROLE_MODEL_MAX_CELLS` is not applied: the tag's own 10 cells are its cap and
`clip` cannot exceed them). Precedence: the name clip is confined to columns
4–12 (`ROLE_NAME_CELLS`, C5), so a 9+ cell name cannot eat the tag; the tag
always starts in column 14 behind `ROLE_NAME_GAP_CELLS`. At `W = 35` the
built-in head is ` 1.explore   [built-in]       ` (30 cells: tag 10 + 6 pad +
1 separator, so 7 spaces after `]`). At `W = 29` it is
` 1.explore   [built-in] ` (24 cells, no pad). At `W = 28` the 9-cell column
clips the tag to `[built-i…`, head ` 1.explore   [built-i… ` (23 cells). At
`W = 19` the column is 0 cells, so the slot is `""` and the tag disappears
while the separator stays.

Composition and fixture location (A.9): `roleHead` in `src/lib/collect.ts`
gains one `builtin` flag (from `agent.id ∈ BUILTIN_AGENT_IDS`) and takes the
slot branch above; `PanelRow` keeps its shape and the TUI renders `row.head`
verbatim, never composing a role head (`src/tui.tsx:344`). The exact
tag-row strings are therefore pinned in `src/lib/collect.test.ts` through
`panel()`, inside the pure layer. This answers the earlier flag about
title-string fixtures living outside the pure layer: the **role-row** head
strings are not one of them, and no TUI-side built-in head composition is
introduced.

**Proportional path (A.11, §1.4).** Detection succeeded and neither field
floor binds. `N` is the name field, `M` the model field, `N + M = W − 10`:

| Columns | Cells | Field | Constant |
| --- | --- | --- | --- |
| 1–3 | 3 | number: two digits + `.` | `ROLE_NUMBER_CELLS` |
| 4–(3+N) | N | agent name, clipped with `…` to `N`, padded to `N` | `ROLE_NAME_SHARE_NUM`/`_DEN` (C40), `ROLE_NAME_MIN_CELLS` (C42) |
| 4+N | 1 | space between name and model | `ROLE_NAME_GAP_CELLS` |
| (5+N)–(W−6) | M | model field: label clipped to `min(M, ROLE_MODEL_MAX_CELLS)`, padded to `M`; a built-in row puts `BUILTIN_TAG_TEXT` here (C50) | `ROLE_REST_FIXED_CELLS` (C38), `ROLE_MODEL_MIN_CELLS` (C43), `ROLE_MODEL_MAX_CELLS` |
| W−5 | 1 | separator before the boxes | `ROLE_BAR_GAP_CELLS` |
| W−4–W | 5 | speed boxes (tight between glyphs) | `BAR_CELLS` |

```
rest  = W − ROLE_REST_FIXED_CELLS                 // C38: W − 10
N     = roundHalfUp(rest × ROLE_NAME_SHARE)       // C40: 2/5, half-up (§1.4)
M     = rest − N
binds = N < ROLE_NAME_MIN_CELLS || M < ROLE_MODEL_MIN_CELLS
```

`binds` selects the fallback table above (C48); a split is never half-applied.
Head = `3 + N + 1 + M + 1 = W − 5`; plus 5 boxes = `W`.

The name clip budget on this path is the whole name field `N` (C48), with no
9-cell cap: `clip(name, N)`, padded to `N`. R2's 9-cell maximum is the
fallback path's rule only (R2 as amended, F31 settled).

Exact rows, member `explore` with `agent.model = Go/Kimi K3.1 Pro`:

- `W = 35` (rest 25): `N = 10`, `M = 15`. The 16-cell label splits to
  `Go/Kimi K3.1 P…` (15 cells: provider `Go`, model budget 12) and the head is
  `" 1.explore    Go/Kimi K3.1 P… "` (30 cells: 4 spaces after `explore`, the
  15-cell label, the separator) + 5 boxes. At the same `W` the fallback head
  is `" 1.explore   Go/Kimi K3.1 Pro "`.
- `W = 50` (rest 40): `N = 16`, `M = 24`. The label fits, 8 pad cells →
  `" 1.explore          Go/Kimi K3.1 Pro        "` (45 cells: 10 spaces after
  `explore`, 16-cell label, 8 pad + 1 separator) + 5 boxes.
- Name budget is the whole field `N`: at `W = 35` (`N = 10`) a 13-cell name
  `"design-review"` clips to `"design-re…"` (10 cells); on the fallback path
  at the same width the 9-cell field gives `"design-r…"`. At `W = 50`
  (`N = 16`) the 19-cell `"explore-deep-review"` clips to
  `"explore-deep-re…"` (16) and a 12-cell name renders whole.
- Built-in `explore`, `W = 35`: tag 10 cells in the 15-cell field, 5 pad →
  `" 1.explore    [built-in]      "` (30 cells).
- Built-in `explore`, `W = 26` (rest 16, `N` 6, `M` 10): name `"explo…"`, tag
  whole with no pad → `" 1.explo… [built-in] "` (21 cells). At `W = 25`
  (`N` 6, `M` 9) the tag clips to `"[built-i…"` → `" 1.explo… [built-i… "`
  (20 cells). The tag is whole exactly when `M >= 10`, the tag's own width
  (C50); Product's "below ~11" resolves to that boundary.

### 1.2 Instance row

**Fallback path (detection unavailable, or a floor binds): the pre-A.11
arithmetic, unchanged.**

| Columns | Cells | Field | Constant |
| --- | --- | --- | --- |
| 1–3 | 3 | indent: space, glyph (`├` or `└`), space | `INSTANCE_INDENT_CELLS` |
| 4–11 | 8 | session title, clipped with `…`, padded | `INSTANCE_TITLE_CELLS` |
| 12 | 1 | space between title and model | `INSTANCE_TITLE_GAP_CELLS` |
| 13–(W−6) | W−18 | model column: label clipped to `min(W−18, 12)`, padded to the column; all spaces when A.10 omits the label (C35, C36) | `INSTANCE_FIXED_CELLS`, `INSTANCE_MODEL_CELLS` |
| W−5 | 1 | separator before the boxes | `INSTANCE_BAR_GAP_CELLS` |
| W−4–W | 5 | speed boxes (tight between glyphs) | `BAR_CELLS` |

Head length = `3 + 8 + 1 + (W−18) + 1 = W − 5`; plus 5 boxes = `W`.

At `W = 35`: indent 3, title 8, space 1, model column 17 (12 text cells + 5
padding), separator 1, boxes 5. `3 + 8 + 1 + 17 + 1 + 5 = 35`. The title field
is always 8 cells even when the row is narrow; the model text shrinks below 12
only when the column itself is narrower than 12 (`W < 30`).

Both shapes put the separator in column `W − 5`, so the last model cell and the
bar align across role and instance rows.

A.10 omission (C35, C36). The decision is the **filler slot**, not a reflow:
the model field keeps its `M` cells (`W − 18` on the fallback path) and holds
spaces when the label is suppressed. Reflow is rejected because it would have
to widen the title field past `T` (C11 caps it at 8) or move the model field's
start column, which would make the bar column depend on the title text. The
arithmetic:

```
shown(instance, role) = resolvedShort(instanceRef) !== resolvedShort(roleRef)
modelField = shown ? padCells(fitModel(label, min(M, INSTANCE_MODEL_CELLS)), M)
                   : " ".repeat(M)
head       = " " + glyph + " " + padCells(clip(cleanTitle(title), T), T)
             + " ".repeat(INSTANCE_TITLE_GAP_CELLS) + modelField
             + " ".repeat(INSTANCE_BAR_GAP_CELLS)
```

`T` is the title field and `M` the model field (§1.2, C49): the fallback path
gives `T = 8`, `M = W − 18`; the proportional path gives
`T = min(roundHalfUp((W − 10) × 2/5), 8)` and `M = W − 10 − T`.

`resolvedShort(ref)` is the single spelling of a resolved label:
`ref ? shortLabel(ref) : UNKNOWN_MODEL`. `instanceRef` is R8's `modelRef` for
the session; `roleRef` is the section's `agent.model` (§R3 comparison
operands). The comparison runs on these unclipped strings, so two labels that
would clip to the same 12-cell text still differ (C35).

Both branches produce a `W − 5`-cell head: the model field width never
changes between them, only its content, so the separator stays in column
`W − 5` and the boxes stay in columns `W − 4 … W` on every row. That is what
preserves R5's last-5-columns invariant across rows where one instance shows a
label and the one above it does not (T12).

At `W = 35` (column 17): omitted → 17 spaces, so a title `Inspect modules`
(`Inspect…`) gives head `" └ Inspect…                   "` (30 cells: 19 spaces
after the title). Shown with R8 label `Go/Grok 4.7` → 6 pad + 1 separator
after an 11-cell label, head `" └ Inspect… Go/Grok 4.7       "` (30 cells).
At `W = 29` (column 11) the omitted slot is 11 spaces; at `W = 19` (column 1)
it is one space, so the head is `" └ Inspect…   "` (14 cells) and the row is
still exactly 19 cells with its 5 boxes (C36's width-pressure fixture).

**Proportional path (A.11, §1.4).** `T` is the title field, `M` the model
field, `T + M = W − 10`; the title keeps its 8-cell cap, so every title cell
the share grants beyond 8 flows into the model field:

| Columns | Cells | Field | Constant |
| --- | --- | --- | --- |
| 1–3 | 3 | indent: space, glyph, space | `INSTANCE_INDENT_CELLS` |
| 4–(3+T) | T | session title, clipped with `…` to `T`, padded to `T` | `INSTANCE_TITLE_SHARE_NUM`/`_DEN` (C41), `INSTANCE_TITLE_MIN_CELLS` (C44), `INSTANCE_TITLE_CELLS` |
| 4+T | 1 | space between title and model | `INSTANCE_TITLE_GAP_CELLS` |
| (5+T)–(W−6) | M | model field: label clipped to `min(M, INSTANCE_MODEL_CELLS)`, padded to `M`; all spaces when A.10 omits the label (C35, C36) | `INSTANCE_REST_FIXED_CELLS` (C39), `INSTANCE_MODEL_MIN_CELLS` (C45), `INSTANCE_MODEL_CELLS` |
| W−5 | 1 | separator before the boxes | `INSTANCE_BAR_GAP_CELLS` |
| W−4–W | 5 | speed boxes (tight between glyphs) | `BAR_CELLS` |

```
rest  = W − INSTANCE_REST_FIXED_CELLS             // C39: W − 10
share = roundHalfUp(rest × INSTANCE_TITLE_SHARE)  // C41: 2/5, half-up (§1.4)
T     = min(share, INSTANCE_TITLE_CELLS)          // C11 cap: 8
M     = rest − T                                  // unused title cells → model
binds = T < INSTANCE_TITLE_MIN_CELLS || M < INSTANCE_MODEL_MIN_CELLS
```

`binds` selects the fallback table above (C49); a split is never half-applied.
Because `T <= 8`, `M` is never smaller than the fallback field at the same
`W`: the proportional path only adds model room and moves the boundary
between the two fields.

Exact rows, title `Inspect modules`, shown label `Go/Grok 4.7` (11 cells):

- `W = 35` (rest 25): `share = 10`, `T = 8`, `M = 17`. The two unused share
  cells go to the model field, so the row is identical to the fallback row
  `" └ Inspect… Go/Grok 4.7       "` (30 cells).
- `W = 28` (rest 18): `share = 7`, `T = 7`, `M = 11` → title `"Inspec…"`,
  head `" └ Inspec… Go/Grok 4.7 "` (23 cells). The fallback head at the same
  width is `" └ Inspect… Go/Grok 4… "` (23 cells: 8-cell title, 10-cell
  field).
- `W = 24` (rest 14): `T = 6`, `M = 8`. At `W = 23` (rest 13) the share is 5,
  so the title floor binds and the fallback arithmetic (8 / 5) governs.
- Omitted label: the slot is `M` spaces (C36). At `W = 28` that is 11 filler
  cells, so the head is `" └ Inspec…"` + 13 spaces (gap 1, 11 filler,
  separator 1) = 23 cells.

Composition (A.10) stays in the pure layer, the A.9 way: `instanceLabel` in
`src/lib/collect.ts` takes the section's role baseline and returns
`string | undefined` (`undefined` when the two resolved labels are equal);
`instanceHead` takes `string | undefined` and writes the filler slot for
`undefined`; the TUI keeps rendering `row.head` verbatim (`src/tui.tsx:344`)
and composes nothing. T6–T14 are therefore pinned through `panel()` in
`src/lib/collect.test.ts`.

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

Budgets are path-dependent (A.11; C48, C49, C50). Fallback path: role label
`min(W−19, ROLE_MODEL_MAX_CELLS)`, instance label
`min(W−18, INSTANCE_MODEL_CELLS)`, built-in tag `clip(BUILTIN_TAG_TEXT, W−19)`.
Proportional path: role label `min(M, ROLE_MODEL_MAX_CELLS)`, instance label
`min(M, INSTANCE_MODEL_CELLS)`, built-in tag `clip(BUILTIN_TAG_TEXT, M)`, where
`M` is that row shape's model field (`N + M = W − 10` role, `T + M = W − 10`
instance). The **name** budget is the full derived field `N` on the dynamic
path (no 9-cell cap, R2 as amended) and 9 on the fallback path; the title
budget is `T` (already `<= 8`) and 8 respectively. The built-in tag bypasses
`fitModel` entirely:
no split rule applies to it (C33, A.9). A.10's
comparison happens **before** this section: it compares the unclipped short
labels (C35), and an omitted instance label never enters `fitModel` or `clip`
(C36) — the slot is plain spaces, not a clipped empty string. The
picker label uses a plain `clip(label,
PICKER_MODEL_CELLS)` — the split rule is not applied there (R9) — and the
picker agent uses `clip(agent, PICKER_AGENT_CELLS)` with the same `clip` rule
(§1.3, C24, C28, F16).

### 1.4 Width detection and row width (A.11, three-rung ladder at A.12)

The row width is derived at render time from the host's rendered environment.
Nothing about it is stored, snapshotted, or persisted.

**Priority ladder.** R5 (A.12) measures `W` in this order; the first rung that
produces a value wins. The configured `width` is never a measurement input: it
is the fallback when no rung produces a value, and the cap when any rung does.

1. **Rung 1 — the renderer's own layout tree, in terminal cells (C51).**
   Authoritative: the panel is laid out inside that box, so the value already
   is a cell count and needs no pixel conversion.
2. **Rung 2 — sidebar pixels ÷ runtime pixels-per-cell (C52, C46).** The
   divisor is measured from the terminal's reported pixel resolution and the
   renderer's terminal columns, not assumed.
3. **Rung 3 — sidebar pixels ÷ the last-resort `CELL_PX` (C37, C46).** Best
   effort, used only when rung 2 has no pixel resolution to read.

**SDK surface — panel frame** (`node_modules/@opencode/plugin/dist/gui/solid.d.ts:33-70`),
the rung 2/3 input:

- `usePanel(): PanelFrame` — valid only inside a `Panel.render`; it throws
  outside one.
- `PanelFrame.placement()` — `"side" | "mobile"`.
- `PanelFrame.visible()` — region open and this tab selected.
- `PanelFrame.sidebar: PanelSidebar` — `opened()` (reactive), `width()`
  (reactive, CSS pixels), `transition()` (`false` until the stored width
  loads). `width()` is "the inner sidebar preference every side panel shares".
  It measures the **inner sidebar region**, which may include frame chrome
  (padding, borders, the reserved region toggle); the design treats it as the
  slot content width without subtracting padding, and the rung-3 divisor is
  the calibration knob for that drift. No padding constant exists (F35,
  settled).

**Host constraint — no static gui submodule import (F38, post-ship A.12).**
The TUI plugin loader provides only the host's `effect` and
`@opencode/plugin` modules. A static submodule import fails the **whole
plugin** at load with, verbatim:

```
Error: Cannot load "@opencode/plugin/dist/gui/index.js" from plugin node_modules: "@opencode/plugin/dist/gui/index.js" is not provided by OpenCode; plugins must use the host's "effect" and "@opencode/plugin" modules.
```

`src/tui.tsx` therefore never statically imports `@opencode/plugin/gui` (or
any `dist/gui` path). The module is resolved at runtime with a dynamic
`import("@opencode/plugin/gui")` inside the plugin setup's `try`, and the
accessor is cached for that activation; any failure — loader rejection, the
module not being shipped, or anything else — caches `undefined`. `usePanel()`
itself still runs inside the panel render, because the SDK throws outside a
`Panel.render`. An unavailable probe is treated exactly like the existing
unavailable list: silent, no toast. Rungs 2 and 3 then have no pixel source,
`rowWidth` receives no probe and runs rung-1-only semantics, and the
configured width governs whenever rung 1 cannot read.

**SDK surface — renderer** (`node_modules/@opencode/plugin/dist/tui/context.d.ts:483`,
`@opentui/core/renderer.d.ts`), the rung 1/2 input. `context.renderer` is a
`CliRenderer`:

- `root: RootRenderable` — the layout tree root (`renderer.d.ts:270`).
- `width`, `height` — terminal size in **cells** (`renderer.d.ts:271-272`).
  `width` is the whole terminal's column count, which is what rung 2 needs:
  the pixel ratio is per cell and the same for every cell on the screen.
- `get resolution(): PixelResolution | null` — device pixels across the
  terminal (`renderer.d.ts:441`, `PixelResolution` at `:74-77`), derived from
  the terminal pixel-resolution escape
  (`lib/terminal-capability-detection.d.ts:22-30`). `null` when the terminal
  never reported it.
- `on("resize", (width, height) => void)` — `CliRenderer extends EventEmitter`
  and `RendererEvents.resize` is typed (`types.d.ts:120`); the event is
  debounced until the new size is accepted (`renderer.d.ts:553`).
- `Renderable.width` — computed width in cells (`Renderable.d.ts:256-258`);
  `Renderable.parent` is the parent renderable (`Renderable.d.ts:193`).
  The TUI renders into opentui's cell grid (`buffer.d.ts:9-15`
  `BufferAccess`), not the DOM; the `CSS pixels` of `sidebar.width()` are the
  `gui/solid.d.ts` wording and are treated as the rung 3 calibration only.

**Rung 1 read rule (C51).** The plugin measures the box it is laid out in, from
its own rendered node, with one traversal rule and no walk beyond the
immediate parent:

```
P  = the full-mode panel's outer <text wrapMode="none"> renderable
     (captured by `ref`; compact mode has no width arithmetic and no node)
A  = P.parent                     // the host's slot boundary box
ok = P && A && A !== renderer.root
     && Number.isFinite(A.width) && A.width > 0
     && A.width > P.width
layoutCells = ok ? A.width : undefined
```

- **Why `P.parent` and not the rows.** The rows are `P`'s text content, so
  `P.width` is the row width itself. Reading it would feed this pass's `W`
  back into the next pass's measurement (wrap-shrink: rows sized in cells
  size their parent). The read is therefore taken on the **ancestor**, which
  the host lays out; the row content can only overflow it, never define it.
- **Equality is a stable box, not authority (C53, PM arbitration).**
  `A.width === P.width` cannot be distinguished from a shrink-wrapped
  ancestor whose width the rows produced, so it never counts as a fresh rung-1
  reading and never invents a width. It is honoured only against the record a
  **rung-1 win already wrote in this activation**: when `lastAccepted` is
  defined and equals the rows' current width, the pass keeps that width
  (`rung 1`, no rung-2 consult). A stale record — undefined, or not equal to
  the rows — is ignored and the pass falls to rung 2. Adopting the equal value
  *without* a record would latch it (a fallback-path pass would lock the
  configured width in and block detection), which is why the record is
  required; the record itself can only come from a strictly wider box.
- **Pane container rule.** The immediate parent is the host's slot boundary,
  which the sidebar lays out at the pane's content width. The design does not
  climb past it: a further ancestor can be the sidebar region, which includes
  frame chrome and would over-report by that chrome. Rung 1 therefore reports
  the slot boundary's content box, not the region.
- **Ambiguous → next rung.** `layoutCells` is `undefined` when: the node is not
  mounted (first pass, compact mode, sidebar closed); `P.parent` is missing or
  is `renderer.root`; the ancestor width is not finite or not positive; the
  ancestor width equals `P.width` and the C53 record is stale; the
  rows are wider than the ancestor (the pane is narrower than the rendered
  content, so the pane's own width is better read from the sidebar pixels); or
  any getter throws. The value is read **per pass** inside the guarded memo,
  never snapshotted as a width, never held in a signal. The one stored value is
  the C53 record (below), which is a width the panel already adopted.
- **Two-cycle and its dampener (C53).** Rung 1's input is the previous layout
  frame; rungs 2/3 are state-free. Without a record, rows that exactly fill the
  slot box alternate between rung 1 (box) and rung 2 (pixel estimate) when the
  two sources disagree — the 40-versus-35 case. The record removes it by
  construction: pass 1 (rows 35, box 40) wins rung 1 and records 40; pass 2
  (rows 40, box 40) is a stable box, keeps 40, and stays there until the box or
  the pixel source changes. Anti-latch survives because the record exists only
  after a strict rung-1 win, and shrink detection survives because a box
  **narrower** than the rows (`A < P`, or an unreadable box) clears the record
  and hands the pass to rung 2 (`accepted` is `undefined`).
- **Invalidation.** One `context.renderer.on("resize", bump)` per activation,
  released on the activation's dispose path (the same cleanup that releases
  the slot claim; `onCleanup` where a reactive owner exists). Every pass
  re-reads `A.width` (cheap);
  no polling and no timer. Reading `renderer.width`/`resolution` is a bare
  getter read and does not subscribe, so the resize event is the terminal
  resize trigger while the reactive `sidebar.width()` read stays the sidebar
  drag trigger.
- **Bootstrap and detach (identity rule, PM arbitration).** Before the ref
  attaches there is no rung 1. The SDK's refs fire **on mount only**: the insert
  effect calls `props.ref(node)` (`@opentui/solid/index.js:430`, and `:884` in
  the slot path), and the removal path `_removeNode` (`:557`) never calls it
  with a `null`/absent node. The callback therefore compares **node identity,
  not absence**:

  ```
  if (node !== panelNode) { panelNode = node; props.bump() }   // a fresh instance = a new full-mode mount
  ```

  A different node object is a new full-mode mount and bumps the view signal
  once, so the first measured pass follows the first layout frame; a repeated
  call for the same node does nothing. The ref lives in the inner full-mode
  component, so `onCleanup(() => { panelNode = undefined })` clears the pointer
  when that subtree unmounts — compact swap, sidebar close, region teardown —
  and no pass ever reads `.parent`/`.width` from a detached node. There is no
  absence case to handle because refs never deliver one. The C53 record
  survives a remount (per activation, not per node) and is revalidated against
  the new rows' width before it is ever used; nothing polls.

**Rung 2 (C52).** `runtimeCellPx = resolution.width / renderer.width`, both
read in the same pass. Both must be finite and `> 0`; `resolution === null`
means the terminal reports no pixel size and rung 2 is skipped. Rung 2 uses
the **same px source as rung 3** — the host's sidebar pixel width — and takes
only the *divisor* from the renderer instead of the 8-pixel assumption, so the
algebra is
`cells = roundHalfUp(cssWidth / (resolution.width / renderer.width))`.

**Rung 3 (C37).** `cells = roundHalfUp(cssWidth / cellPx)` with `cellPx` from
the existing option, defaulting to `CELL_PX = 8` when the value is absent, not
finite, or not positive (`resolveCellPx`, unchanged). The option is read by
rung 3 **only**; rung 2 never reads it, so a user-set `cellPx` no longer
affects a panel whose terminal reports its pixel resolution. It stays a manual
brake and a test override for terminals that report none — that is the whole
of its contract.

**Probe (pure).** The TUI resolves the gui module at runtime (dynamic import at
setup, F38) and reads the host accessors into plain objects, so the
ladder and its rounding are testable without the SDK:

```ts
type WidthProbe = {            // unchanged from A.11
  placement: "side" | "mobile"
  visible: boolean
  opened: boolean
  loaded: boolean      // transition()
  cssWidth: number     // sidebar.width()
}
type RuntimeMetrics = {        // A.12: renderer-derived readings only
  layoutCells?: number       // C51: rung-1 cell count, strictly wider than the rows
  boxCells?: number          // C53: one read of A.width, compared to rowsCells
  rowsCells?: number         // C53: P.width, a separate read of the panel node
  resolutionWidth?: number   // device pixels across the terminal
  rendererColumns?: number   // terminal columns
}
function runtimeCellPx(metrics: RuntimeMetrics | undefined): number | undefined   // C52
function selectCells(probe: WidthProbe | undefined, metrics: RuntimeMetrics | undefined,
                     fallbackCellPx: number): { cells: number; rung: 1 | 2 | 3 } | undefined
function rowWidth(declaredWidth: number, cellPx: number, probe?: WidthProbe,
                  metrics?: RuntimeMetrics, lastAccepted?: number):
  { W: number; dynamic: boolean; rung?: 1 | 2 | 3; accepted?: number }   // accepted = C53 record
```

`selectCells` (C46) is unchanged by the dampener; it never sees
`lastAccepted` and reports rung 1 only for a strictly wider box:

```
gates = probe && probe.placement === "side" && probe.visible
        && probe.opened && probe.loaded
if (!gates) return undefined
if (layoutCells present, finite, > 0) return { cells: roundHalfUp(layoutCells), rung: 1 }
px = runtimeCellPx(metrics)
if (px !== undefined && cssWidth finite > 0) return { cells: roundHalfUp(cssWidth / px), rung: 2 }
if (cssWidth finite > 0) return { cells: roundHalfUp(cssWidth / resolveCellPx(fallbackCellPx)), rung: 3 }
return undefined
```

The shared gates are the A.11 gates and apply to all three rungs and to the
C53 stable box: a slot
outside `Panel.render` (`prompt.footer`) has no frame, so nothing applies and
the configured width governs (F34). A rung whose own reading is absent falls
through to the next; the rung index is returned for tests and diagnosis only
and changes no arithmetic.

`rowWidth` (C47, with the C53 record):

```
declared = max(MIN_ROW_CELLS, declaredWidth ?? DEFAULT_WIDTH)
detected = selectCells(probe, metrics, cellPx)
stable   = gates(probe) && metrics && metrics.boxCells === metrics.rowsCells
           && lastAccepted !== undefined && lastAccepted === metrics.rowsCells
if (detected?.rung === 1):
    W = clamp(detected.cells); rung = 1; accepted = W          // C51 win
else if (stable):
    W = clamp(lastAccepted);   rung = 1; accepted = lastAccepted   // C53 keep
else:
    W = detected === undefined ? declared : clamp(detected.cells)
    rung = detected?.rung; accepted = undefined                // C53 cleared
clamp(x) = max(MIN_ROW_CELLS, min(declared, x))
dynamic  = rung !== undefined
```

`accepted` is the value the TUI stores as `lastAccepted` for the next pass; it
is `undefined` on every non-rung-1 outcome, so a stale record cannot survive a
shrink, an unreadable box, or a fall-through.

The floor `MIN_ROW_CELLS = 19` is unchanged in both paths: the detected width
passes through the same `effectiveWidth(W) = max(MIN_ROW_CELLS, W)` that
`panel()` already applies to the configured width, so a detected 12 becomes 19
exactly as a configured 12 does. A sidebar narrower
than 19 cells yields a 19-cell row that overflows the region — the same
consequence F1 already accepts for a configured width below 19 (F33, settled).
The cap is `declared`, so detection can only narrow a row, never widen it.

**Rounding.** Every width rounding (A.11, A.12) is half-up on non-negative
values:
`roundHalfUp(x) = floor(x + 1/2)`, so a tie `x.5` always rounds **up**
(`260 / 8 = 32.5 → 33`; `288 / 8 = 36.0` stays 36). The share is evaluated in
integers,
`roundHalfUp(rest × NUM / DEN) = floor((2 × rest × NUM + DEN) / (2 × DEN))`,
so no floating-point error can enter a split. Each rung's cell value — the
layout width and both pixel divisions — is rounded once, before the cap;
`cssWidth` and `runtimeCellPx` may be fractional.

**Path selection.** `dynamic` comes from detection alone (any rung produced a
value); the field split additionally needs both floors clear. `binds` is
computed on the fields the split would produce (`N`/`M` role, `T`/`M`
instance); `binds || !dynamic` selects the fallback arithmetic of §1.1/§1.2
exactly as it stands (C48, C49). A split is never half-applied: one row is
wholly proportional or wholly fixed.

Width ladder (all values computed by the rules above; `M` is the model field):

| W | rest | role `N`/`M` | role fixed 9/`W−19` | instance `T`/`M` | instance fixed 8/`W−18` | path |
| --- | --- | --- | --- | --- | --- | --- |
| 19 | 9 | 4/5 → floor | 9/0 | 4/5 → floor | 8/1 | fallback (floor) |
| 23 | 13 | 5/8 → floor | 9/4 | 5/8 → floor | 8/5 | fallback (floor) |
| 24 | 14 | 6/8 | 9/5 | 6/8 | 8/6 | proportional |
| 26 | 16 | 6/10 | 9/7 | 6/10 | 8/8 | proportional (tag whole) |
| 28 | 18 | 7/11 | 9/9 | 7/11 | 8/10 | proportional |
| 29 | 19 | 8/11 | 9/10 | 8/11 | 8/11 | proportional |
| 35 | 25 | 10/15 | 9/16 | 8/17 | 8/17 | proportional |
| 50 | 40 | 16/24 | 9/31 | 8/32 | 8/32 | proportional |
| 80 | 70 | 28/42 | 9/61 | 8/62 | 8/62 | proportional |

Floor edges: the last floor-bound width is 23 (role name 5, instance title 5);
24 is the first proportional width. Tag edge: whole at `M >= 10` (W = 26),
clipped at `M = 9` (W = 25). Detection edges: W is the minimum of `declared`
and `detected`, then floored at 19; `detected` is whichever rung produced it,
and the table keys off `W` alone, so no row value changes with the rung.

**Where it is read (TUI).** `src/tui.tsx` sits in SolidJS. Plugin setup
resolves the gui module's `usePanel` accessor once per activation with a
dynamic import (never a static one, F38), the panel render component calls it
once in its body, and the **inner full-mode
component** owns the layout handles, captures the panel node by `ref`, and
reads the probe plus the renderer readings **inside the same `guarded` memo
that builds the view**, so the width stays reactive:

```ts
// Amended since A.12 (F38): no static gui submodule import — the loader fails
// the whole plugin. Resolve the accessor per activation; any failure caches
// undefined and the probe degrades silently to rung-1-only (§1.4).
let frameOf: (() => PanelFrame) | undefined
try {
  frameOf = (await import("@opencode/plugin/gui")).usePanel
} catch {
  frameOf = undefined              // loader rejection, unshipped module, throw
}

// Status owns the C53 record for the whole activation and renders
// <Show when={!compact()} fallback={compactLine}><FullPanel .../></Show>;
// FullPanel unmounts when compact wins, so its cleanup is the detach signal.
let lastAccepted: number | undefined            // C53, per activation (Status scope)

function FullPanel(props: { context: Context; bump: () => void;
                            lastAccepted: () => number | undefined;
                            accept: (next?: number) => void; ... }) {
  let panelNode: TextRenderable | undefined     // layout handle, not a width
  // refs fire on mount only (@opentui/solid/index.js:430, :884); removal never
  // calls back (_removeNode, :557), so identity — not absence — is the signal.
  const attachPanel = (node: TextRenderable) => {
    if (node !== panelNode) { panelNode = node; props.bump() }  // new instance = new mount
  }
  onCleanup(() => { panelNode = undefined })   // subtree unmount: no phantom reads

  // inside the guarded memo, next to sources() and panel():
  // The module is the one resolved at setup; usePanel() still runs here because
  // it throws outside Panel.render. No static import (F38).
  const frame = (() => { try { return frameOf?.() } catch { return undefined } })()
  const probe: WidthProbe | undefined = frame && {
    placement: frame.placement(), visible: frame.visible(),
    opened: frame.sidebar.opened(), loaded: frame.sidebar.transition(),
    cssWidth: frame.sidebar.width(),
  }
  const metrics: RuntimeMetrics | undefined = (() => {
    try {
      const renderer = props.context.renderer
      const parent = panelNode?.parent ?? undefined
      const boxCells =
        panelNode && parent && parent !== renderer.root
          && Number.isFinite(parent.width) && parent.width > 0
          ? parent.width : undefined
      return {
        // C51: one read of A.width, two projections. Strict authority:
        layoutCells: panelNode && boxCells !== undefined && boxCells > panelNode.width
          ? boxCells : undefined,
        // C53: that same A.width, compared to rowsCells (a separate P.width read):
        boxCells,
        rowsCells: panelNode?.width,
        resolutionWidth: renderer.resolution?.width,
        rendererColumns: renderer.width,
      }
    } catch {
      return undefined        // a width failure is a fallback, never a toast
    }
  })()
  const { W, dynamic, accepted } = rowWidth(
    props.width(), props.cellPx(), probe, metrics, props.lastAccepted(),
  )
  props.accept(accepted)   // C53: the record either advances or clears
  return <text wrapMode="none" ref={attachPanel}>…</text>
}
```

Reading `sidebar.width()` inside the memo is what makes the row width
reactive: the host's accessor is a signal, so a sidebar drag re-runs the memo
and `panel()` rebuilds every row at the new `W`. A terminal resize is a plain
getter read with no subscription, so `setup` adds exactly one listener,
`context.renderer.on("resize", bump)`, released on the activation's dispose
path (the same cleanup that releases the slot claim; `onCleanup` inside a
reactive owner). Inside `FullPanel` the full-mode `<text>` carries
`ref={attachPanel}`; compact mode renders no `FullPanel`, so no node is
captured and its cleanup has already cleared the pointer. Only the frame handle
and the renderable handle are kept — both layout handles, neither a width
value. The width is never snapshotted as a detection input and never written
to storage; the one retained number is C53's adopted-width record, which the
ladder itself produced (below). There is no polling:

- **R11.** `usePanel()` and the renderer reads sit inside the existing guard's
  `try`, so a throw (a slot that is not inside a `Panel.render`, for example
  `prompt.footer`; a destroyed renderer; a detached renderable) degrades to
  `probe`/`metrics` `undefined` and the next rung or the configured-width path
  — not to a toast. Only a genuine build failure reaches the toast, and width
  fallbacks never dedupe against a toast because they emit none. An unresolved
  gui module (F38) reaches the same path with `frame` undefined; it is not a
  build failure and emits no toast.
- **C53 record (not a panel cache).** `lastAccepted` is a single number held
  by the outer panel component for one activation (passed into the inner
  full-mode component), TUI-side, never persisted and
  never a signal. It is assigned every pass from `rowWidth`'s `accepted`, which
  is `undefined` on any non-rung-1 outcome, so it clears itself when unused.
  It does not touch the A.8 member snapshot, `sources()`, the view, or G16;
  losing it (a remount, a reload) only costs one rung-1 measurement pass.
- **`prompt.footer`.** It is a `context.ui.slot` prompt-region append, not a
  panel render, so `usePanel()` throws there. Detection does not apply (the
  shared gates fail) and the configured `width` governs every time (F34).
  `sidebar.content` and `sidebar.footer` attempt the ladder and fall back when
  the host exposes no frame.
- **Live width change.** A resize between two recomputes rebuilds the rows at
  the new `W`. Only field sizes and their text change: order, numbering,
  `working`, `total`, `more`, `filled`, `tps` and every row `state` are
  width-independent, so no grace window starts, ends, or moves and the R4
  ticker is not restarted (T21).
- **No data sync.** Width detection reads no data-layer source and triggers no
  `session.sync`, `message.sync`, or host event subscription: the one listener
  is the renderer's `resize`, which is a layout event, not a data event. G16
  (the message re-sync gate, §2) is untouched.
- **Compact mode** renders the single line `sub N` and has no width
  arithmetic; no node is captured and no rung applies.
- **One constant, one meaning.** Rung 1 produces a cell count, rungs 2 and 3
  produce a cell count from a pixel count; `CELL_PX` remains a pixel count and
  is never a cell width, a field size, or `DEFAULT_WIDTH` (C37, C51, C52).

## 2. Data flow

One recompute per watched event (including a message content update) and per
grace tick. The plugin stores no session state; every field is derived from a
host source at render time. The one exception is the member-set snapshot
(A.8, §2.1): it is taken once per location and then read as data on every
recompute.

| Source | Provides | Feeds |
| --- | --- | --- |
| `context.data.location.agent.list(location)` | id, name, model, mode, hidden, color | member-set snapshot (mode, member roles, `M`); definitions for temporary builtin rows; agent models/colours/names; R8 step 2; live definition model as the A.10 role baseline for a temporary row |
| member-set snapshot (TUI, A.8) | `MemberSet` from `memberSet(agent.list)` on the first render per location | `view.mode`, member idle rows, `total` (`M`), temporary-row classification (§2.1), A.10 role baseline for member rows |
| `context.data.session.list()` | child sessions: id, parentID, agent, model, title, outcome, time | instance set, attribution to a role, title, grace eligibility |
| `context.data.session.get(id)` | one session by id | ancestor walk for R8; session open |
| `context.data.session.root(id)` | root session id | tab scope (R3) |
| `context.data.session.status(id)` | `running` / `idle` | active vs not |
| `context.data.session.message.list(id)` | assistant messages with optional `tokens` (`output`, `input`, `reasoning`, `cache`) and `time.created` / `time.streamed?` / `time.completed?` | `tps` numerator and denominator (chain below) |
| `context.data.session.sync(id)`, `context.data.session.message.sync(id)` | loads one session / its messages into the TUI data cache | populates `session.list`/`session.get` and `message.list` before they are read (G16) |
| `context.data.location.model.list(location)` | model id, modelID, providerID, name | model display names only; `limit.context` is no longer read |
| `context.data.location.provider.list(location)` | provider id, name | provider display names / short label last word |
| `context.theme` | `text.base`, `text.muted`, `text.feedback.success/warning.base` | title, idle/active/grace text, filled boxes (success), empty boxes (muted) |
| `usePanel()` frame (`PanelFrame.sidebar`, SDK `gui/solid.d.ts:33-70`; module resolved at runtime, F38) | `placement()`, `visible()`, sidebar `opened()`, `transition()` (stored width loaded), `width()` in CSS px | rung 2/3 probe only (§1.4, A.11, A.12); layout, never row data and never a sync trigger |
| `context.renderer` (`CliRenderer`) | `root` (layout tree root), `width`/`height` in terminal cells, `resolution` device px or `null`, `"resize"` event | rung 1 layout read (C51) and rung 2 cell calibration (C52), plus the renderer `resize` invalidation (§1.4, A.12); layout only, never row data |
| `context.storage.store("subagent-live-status-plugin")` | persisted `{ compact }` | R10 |
| slot input `sessionID` | viewed session id | R3 tab scope; compact count scope |
| host events (`session.created/deleted/moved/forked/renamed/status/idle/agent.selected/model.selected/execution.started/succeeded/failed/interrupted`, plus `session.step.ended` and `session.message.content.updated`) | invalidation; on `session.created` and `session.execution.started` also a sync trigger, on `session.step.ended` a message re-sync trigger (known-fire: final `tokens` per completed assistant step), on `session.message.content.updated` a second re-sync trigger (delivery unverified; G16) | bump the view signal; load the instance session then its messages; re-read messages when an assistant step ends |
| 1 s ticker | clock while a grace row exists; doubles as a recompute trigger for `tps` (R6) | recompute `now` for grace expiry and re-run `panel()` |

Opening a picked session is an action, not a source: the TUI calls
`context.ui.tabs.focus` for a root session and falls back to
`context.ui.router.navigate({ type: "session", sessionID })`
(`src/tui.tsx:373-378`). It never reads `context.ui.router.current()`, so that
value is not a data source for any field.

Width detection (A.11, ladder at A.12, §1.4) is a layout input, not a data
source. The probe and the renderer readings are read inside the render memo
that builds the view, so a sidebar drag or a terminal resize re-runs the pass
and rebuilds the rows at the new width; neither value is **snapshotted** (the
A.8 member snapshot is unaffected and stays the only snapshot; C53's
`lastAccepted` is a panel-local record of an adopted width, not a source
snapshot). Detection
reads no data layer: no `session.sync`, no `message.sync`, no host event
subscription, so the G16 gate below keeps exactly its two triggers and its
once-per-session bypass. The renderer's `resize` listener is a layout
invalidation owned by the panel component (one per activation, removed on
cleanup), not a data subscription. `prompt.footer` is not a panel render, so
its probe is absent and the configured `width` governs (F34). A detection
failure — an ambiguous layout read, a missing pixel resolution, a detached
renderable, an unresolved gui module (F38) — skips that rung or falls to the
configured width, never to the R11 toast.

Location: the location the TUI is showing (`context.location`, else
`context.data.location.default()`). The plugin never merges agent definitions
from disk; the host's agent list is authoritative. The member snapshot is kept
per location: switching back to a location reuses its frozen snapshot, and a
location seen for the first time takes its own (§2.1, A.8).

A.10's comparison reads no new source and needs no new sync. Both operands are
already in memory during one `panel()` pass: the role baseline comes from the
section, built from `sources.members` or the live `agents` entry; the instance
ref comes from `modelRef(session, sources)`, whose three steps read
`session.model`, the live `agents` list, and `sessions.get` — all sources the
pass already consults (R8, §5). The comparison is recomputed every pass; no
"shown/omitted" bit is cached in the TUI or in the view.

### 2.1 Member selection (A.8)

The mode is a **snapshot**, not a live filter. `src/lib/collect.ts` exports

```ts
type PanelMode = "charter" | "builtin"
type MemberSet = { mode: PanelMode; roles: AgentInfo[] }
function memberSet(agents: AgentInfo[]): MemberSet
```

and `Sources` gains `members?: MemberSet`. `memberSet` partitions the host list
by `BUILTIN_AGENT_IDS` (C32):

- `custom = agents.filter(a => !BUILTIN_AGENT_IDS.includes(a.id))`
- `builtin = agents.filter(a => BUILTIN_AGENT_IDS.includes(a.id))`
- `mode = custom.length > 0 ? "charter" : "builtin"`
- `roles = (mode === "charter" ? custom : builtin).filter(isVisibleRole)`

`mode` looks at the unfiltered `custom` list, so a hidden or primary custom
definition still selects charter mode (a definition exists) while contributing
no row. `roles` is `M`. A builtin id is always builtin-classified, even when a
project file overrides it (identity over origin; F26).

Snapshot: `src/tui.tsx` evaluates `memberSet(list)` on the first render for a
location and stores the result per location (keyed by its directory) for the
life of the plugin instance. If the first read returns `undefined` (host not
loaded), the snapshot waits for the next render that returns an array; the
panel renders nothing until then. Once taken it is never recomputed: adding or
removing a file in `.opencode/agents` later in the session changes neither the
mode nor `M`, and switching back to that location reuses the frozen snapshot.
The next plugin activation is the next snapshot (F25). `panel()` reads
`sources.members` and never derives membership from the live `agents` list; a
missing `members` yields `total = 0` and no rows (`mode` is then the inert
`"builtin"` placeholder), never a fresh decision.

Role sets:

- **Member rows** are `members.roles` in both modes. Their `AgentInfo` values
  are the snapshot's, so a mid-session definition change cannot remove or move
  a member row; `total` is their count, and the member's snapshot `model` is
  the A.10 role baseline. Instance R8 step 2 reads the live list (§5), so a
  definition model changed after the snapshot can make an instance label
  differ from the role baseline; the row then shows the label. Nothing is
  cached: the next pass compares the then-current values.
  Attribution resolves a member id to the
  snapshot entry first; only an id with no member entry may use the live list,
  and only when it is a charter-mode visible builtin (the temporary row).
- **Temporary rows** exist in charter mode only. A session whose `agent` id is
  a visible builtin (`BUILTIN_AGENT_IDS` plus `isVisibleRole`) and is not in
  `members.roles` creates a synthetic section when it has at least one
  in-scope instance (active or grace, §R3 scope). The section definition is
  the live `agent.list` entry (builtins always exist), so name clipping,
  colour fallback, the built-in tag slot (C34: a temporary row is a built-in
  role, so its row shows the tag and never prints the live definition model),
  instance attribution and the R5 arithmetic are the existing role-row code:
  no new field shape, and only the one new text constant. That live definition
  model is still the A.10 **role baseline** for its instance rows: it is read
  as a comparison operand, never printed on the role row (A.9 unchanged,
  C35). The instance rows use R8 as usual.
- **Ignored ids**: a non-builtin id absent from `members.roles` never gets a
  row, even while a session of it runs (its definition appeared after the
  snapshot, or the snapshot is built-in mode). Hidden, primary and unknown ids
  get no row in either mode.
- A temporary section exists only while it has an instance, so only the R3/R4
  states apply to it. A succeeded last instance leaves no row in the same
  pass; a failed or interrupted last instance keeps the instance and role rows
  exactly `GRACE_MS`, then both disappear together. There is no idle temporary
  row.
- Counters: `total = members.roles.length` (`M`), stable all session;
  `working` counts every section with an active instance, temporary sections
  included (`N`). `working` can therefore exceed `total` (`2/1`); that is R1's
  contract, not an error.
- Ordering: temporary sections use the §4 busy rule unchanged (oldest instance
  first, then name/id). They never enter the idle list.

`tps` chain: `message.list(sessionID)` of the instance's own session → keep
assistant messages that pass the §R6 filter → `tokens = Σ tokens.output`,
`ms = Σ (time.completed − time.streamed)` → `tps = 1000 × tokens / ms`.
Nothing else feeds the bar: no model limit, no context window, no token
percentage. `model.list` is read for labels only.

Data availability: `message.list(id)` reads the data layer's cache, which the
client fills only for sessions it has synchronised. The code now syncs before
it reads (`syncSession`, `src/tui.tsx:190-209`) on the touchpoints it already
collects:

- `session.execution.started` or `session.created` for a child session whose
  agent is visible → `context.data.session.sync(sessionID)` first, then
  `context.data.session.message.sync(sessionID)` once the session is loaded.
  The gate stays member-independent: it admits any visible agent's child, so a
  temporary builtin's messages land under a charter member set. Do not narrow
  it to `members.roles`; that would freeze a temporary row's bar at unknown
  (A.8, G16, G20).
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
| idle | member role with no active and no grace instance | `theme.text.muted` | empty (0 filled) | n/a | n/a |
| active | `status === "running"`, member role or temporary builtin role, in scope | agent `color` (parsed), else `theme.text.feedback.success.base` | busiest active instance's fill, fill cells success green | agent `color`, else success | own fill, fill cells success green |
| grace | not running, `outcome` failed/interrupted, `0 <= now − ended < GRACE_MS` | `theme.text.feedback.warning.base` | empty (0 filled; F12) | warning, overrides agent colour | empty (0 filled; F18) |

- Empty boxes (the `5 − filled` remainder) are always `theme.text.muted`,
  independent of the row text (F13).
- Filled boxes are always `theme.text.feedback.success.base`; `barTone` has
  exactly two outcomes, `"success"` (filled > 0) and `"muted"` (filled = 0).
  There is no warning or error box colour (R6).
- Role state: active if any instance active; else grace if any instance;
  else idle.
- A finished succeeded session, an out-of-window failure, a running session
  of a hidden/primary/unknown agent, a running non-member non-builtin session,
  and any session in another tab produce no row. A temporary builtin role is
  active or grace only; it has no idle row.
- Title is `theme.text.base`; the overflow line is `theme.text.muted`.
- The built-in tag is part of the row text, so it takes the row colour above
  and nothing else: muted on an idle built-in row, the agent colour (else
  success green) on a working one, warning during grace. No new tone, and the
  bar logic is untouched — the boxes still follow `barTone(row.filled)`
  (A.9, R6).
- A.10 changes no colour. An omitted model cell is spaces, so there is no text
  to colour; the title, tree glyph, and any shown model label keep the row
  colour rule before and after omission. The bar keeps `barTone(row.filled)`,
  and the empty remainder stays muted (§R6). A row that gains or loses its
  label mid-session changes only the label text, never the tone or state.
- A.11 changes no colour. Field sizes and their clipping move with the width;
  row text, the tag, the boxes and `barTone` keep the rules above, and a live
  width change re-renders the same state (§1.4).
- The panel is hidden at `total = 0`; compact is shown at `total > 0` and is
  the only line then.

## 4. Orderings and overflow

1. Build the member role list from `sources.members` and the instance sections
   per §2/R3/R4; a section may be a member role or a temporary builtin role.
2. Split sections into **busy** (at least one active or grace instance) and
   **idle** (member roles with no instance). A temporary role is always busy.
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
   unnumbered. `working` counts every role with an active instance, member or
   temporary, folded or not; `total` counts member roles only, folded or not.

## 5. Model resolution order

Already specified in R8. The single shared implementation must be used by the
instance rows, the picker, and the speed computation's message scope: each
instance's speed reads only that session's own messages. A role row uses the
definition model of its member (snapshot) or temporary builtin (live) **only
when the agent is not a built-in**; a built-in role row shows the tag and
prints no model at all (R2, A.9, C34). R8 itself is unchanged and stays the
source for every instance row, including an instance of a built-in: that row
keeps its model label (subject to A.10, C35) and never carries the tag. A.9
removes no resolution step; it changes only which text the **role** row
prints.
`sources.agents` keeps the full live list, including builtins that are not
member rows, so R8 step 2 still resolves a temporary builtin's instance to its
definition model. Cycle protection is mandatory: a parent chain that revisits a
session stops the walk and falls through to item 4.

A.10 (C35) adds one derived value, not a new resolution: the **role baseline
label**, `resolvedShort(roleRef)` from the section definition's `agent.model`
(snapshot member or live temporary entry), or `UNKNOWN_MODEL` when the
definition has none. It is computed with the same short-label function as the
instance side, so both sides are directly comparable strings. It is compared
against `resolvedShort(modelRef(session, sources))` **before** the field's
clip/cap; the role model text cap (`min(F, ROLE_MODEL_MAX_CELLS)`) and the
built-in tag do not
enter the comparison. R8's order is untouched: the instance side still runs
own model → live agent definition → ancestor → `UNKNOWN_MODEL`.

A.11 changes no resolution step either: §1.4's field sizes change where a
label clips and how far it pads, never which ref wins. A.12 likewise: the
ladder changes only how `W` is measured, so no ref, label, clip budget or
comparison operand moves. R9's picker keeps its
fixed budgets (`PICKER_MODEL_CELLS` 96, `PICKER_AGENT_CELLS` 24; C24, C28) and
is independent of the sidebar width; R10's palette commands are unchanged.

## 6. Contract numbers

`cellWidth` follows §0. All fixtures are ASCII except the wide-cell cases in
C5 and C11, and the box glyphs in C30/C31 (`▓` U+2593, `░` U+2591), each of
which counts as one cell. Values are exact, not shapes; a fixture that
asserts only width or "contains" does not satisfy R12.

C37–C50 are A.11's dynamic-width numbers; C1–C36 keep their values. A.12
rewrites C46 into the three-rung ladder, demotes C37 to the rung-3 divisor,
and adds C51 (rung-1 layout read), C52 (runtime pixels-per-cell) and C53 (the
stable-box dampener); C38–C45 and C48–C50 keep their values, and C47 keeps its
formula with the rung and the C53 record passed through.
A row string quoted by C2 or C5–C36 is a **fallback-path** fixture unless its row
says otherwise: the column arithmetic is path-independent, only the field
sizes and the text inside them move (§1.1, §1.2, §1.4).

| # | Constant | Value | Field | Fits fixture | Does-not-fit fixture | Req |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | `BODY_MAX_LINES` | 10 | body lines, title and overflow excluded | 10 idle roles → 10 rows, `more = 0` | 11 idle roles → 10 rows, `more = 1` | R1, R7 |
| C2 | `DEFAULT_WIDTH` | 35 | row width when the option is absent | width unset → role head 30 cells + 5 boxes, instance head 30 + 5 | width 30 → role head 25, instance head 25 | R5 |
| C3 | `ROLE_NUMBER_DIGITS` | 2 | role number digits | role 9 → `" 9."`, role 10 → `"10."` | no emitted role index reaches 100 (body cap); the fixture asserts the highest emitted number is the tenth role | R2 |
| C4 | `ROLE_NUMBER_CELLS` | 3 | number field (2 digits + `.`) | first role: `head.slice(0,3) === " 1."` | tenth role: `head.slice(0,3) === "10."` (no leading space, still 3 cells) | R2, R5 |
| C5 | `ROLE_NAME_CELLS` | 9 | agent name field, **fallback path only**; the dynamic path's budget is C48's full `N`, with no 9-cell cap (F31 settled) | `"explore"` → `"explore  "`; 9-cell `"123456789"` unchanged; dynamic twin at W 35 (`N = 10`): 10-cell `"1234567890"` unchanged and padded to 10 | `"1234567890"` → `"12345678…"`; wide `"调研团队组"` (5 wide code points = 10 cells) → `"调研团队…"` (4 wide code points = 8 cells + `…` = 9 cells); dynamic twin at W 35: 13-cell `"design-review"` → `"design-re…"` (10 cells), not `"design-r…"` (9) | R2, R5 |
| C6 | `ROLE_NAME_GAP_CELLS` | 1 | space after the name field | at width 35, `"explore"` + model `Go/Kimi K3.1 Pro` → head `" 1.explore   Go/Kimi K3.1 Pro "` (30 cells, 0-based `head[12] === " "`) | a gap-less implementation starts the model one cell early: its head is `" 1.explore  Go/Kimi K3.1 Pro  "` (30 cells, `head[12] === "G"`, model column 18), so the pinned string fails it | R5 |
| C7 | `ROLE_MODEL_MAX_CELLS` | 20 | role model label text cap | width 40 (column 21): `"Go/Kimi K3.1 Pro Max"` (20 cells) kept whole | width 40: `"Go/Kimi K3.1 Pro Maxx"` (21 cells) → `"Go/Kimi K3.1 Pro Ma…"` (20 cells) | R5 |
| C8 | `ROLE_FIXED_CELLS` | 19 | all row cells except the model column (3+9+1+1+5) | width 19 → model column 0, head 14; width 40 → model column 21, head 35 | width 18 → effective width raised to 19 (F1) | R5 |
| C9 | `BAR_CELLS` | 5 | boxes | `filled = 5` → 5 filled glyphs | `filled = 0` → 5 empty glyphs | R1, R3, R5, R6 |
| C10 | `INSTANCE_INDENT_CELLS` | 3 | indent (space, glyph, space) | first of two instances at width 35, title `Inspect modules`, model `Go/Grok 4.7`: head `" ├ Inspect… Go/Grok 4.7       "` (30 cells) | both directions fail: a not-last instance rendering `" └ Inspect… Go/Grok 4.7       "` (index 1 is `└`), and the last instance rendering `" ├ …"` instead of `" └ …"`; a 2-cell indent shifts the title left (`" ├I…"`) and fails `head.slice(0, 3) === " ├ "`. The fixture pins `├` on every instance except the last and `└` on the last | R3, R5 |
| C11 | `INSTANCE_TITLE_CELLS` | 8 | instance title field cap (both paths; C49 caps `T` at this value) | `"Inspect modules"` → `"Inspect…"`; 8-cell title unchanged | 9-cell `"abcdefghi"` → `"abcdefg…"`; wide `"调研团队组"` (10 cells) → `"调研团…"` (7 cells: 6 + `…`) | R3, R5 |
| C12 | `INSTANCE_TITLE_GAP_CELLS` | 1 | space after the title field | 0-based `head[11] === " "` at width 35 | a 9-cell title is clipped to 8, so no title cell lands in the gap column | R5 |
| C13 | `INSTANCE_MODEL_CELLS` | 12 | instance model label text cap | width 35: `"Go/Kimi K3.1"` (12 cells) kept whole, so the column is 12 text + 5 padding | budget 12: `"OpenCode/Kimi K3.1 Pro"` (22 cells) → split `"Open…/Kimi …"` (12 cells); plain `clip` gives `"OpenCode/Ki…"` (12 cells), so the fixture discriminates the split rule | R3, R5 |
| C14 | `INSTANCE_FIXED_CELLS` | 18 | all row cells except the model column (3+8+1+1+5) | width 35 → model column 17 = 12 text + 5 padding | width 18 → effective width raised to 19, model column 1 (F1) | R5 |
| C15 | separator cell, tight glyphs | `ROLE_BAR_GAP_CELLS` = `INSTANCE_BAR_GAP_CELLS` = 1; 0 between box glyphs | the model column ends one cell before the boxes | width 35 role: `"Go/Grok 4.7"` (11 cells) leaves 5 pad cells in the 16-cell column, then the separator, so head `" 1.explore   Go/Grok 4.7      "` (30 cells) ends with 6 spaces; `"Go/Kimi K3.1 Pro"` (16 cells) fills the column and the separator is the 30th cell (`" 1.explore   Go/Kimi K3.1 Pro "`). Width 35 instance: `"Go/Kimi K3.1"` (12 cells) + 5 pad + 1 separator | width 35 role: `"Go/Grok 4.7 Flash"` (17 cells) → split `"Go/Grok 4.7 Fla…"` (16) and head `" 1.explore   Go/Grok 4.7 Fla… "` (30); the A.3 no-separator column of 17 keeps the label whole (`" 1.explore   Go/Grok 4.7 Flash"`, 30) and fails; a model field that eats the separator renders a 29-cell head (`" 1.explore   Go/Grok 4.7     "`) and fails the 6-space pin. Instance twin at 12 vs 13: `"Go/Grok 4.7.1"` (13) → `"Go/Grok 4.7…"` (12) and head `" ├ Inspect… Go/Grok 4.7…      "`; the 13-cell text under A.3 renders `" ├ Inspect… Go/Grok 4.7.1     "` | R5, R6 |
| C16 | `FILL_MIN_BOXES` | 0 | lower fill clamp | `tps = 0` → `filled = 0` (no band reached) | `tps = 4.99` → `filled = 0` (below the lowest floor) | R6 |
| C17 | `FILL_MAX_BOXES` | 5 | upper fill clamp | `tps = 1000` → `filled = 5` (top band; the count cannot exceed the five bands, so the clamp is a guard) | `tps = 100` → `filled = 4` (exclusive top floor; clamp not binding) | R6 |
| C18 | `FILL_BANDS` | `[5, 20, 50, 70, 100]` tokens/sec, ascending | band floors; floors 1–4 inclusive (`tps >= floor`), floor 5 exclusive (`tps > floor`) | `tps = 5` → `filled = 1`, `20` → `2`, `50` → `3`, `70` → `4` (each inclusive floor reached exactly); `100.01` → `5` (strictly above the top floor) | `tps = 4.99` → `0` (below the lowest floor); `19.99` → `1`, `49.99` → `2`, `69.99` → `3` (one hair below each inclusive floor); `100` → `4` (exactly the exclusive top floor) | R6 |
| C19 | fill formula | `clamp(#{b ∈ FILL_BANDS[0..3] : tps >= b} + (tps > FILL_BANDS[4] ? 1 : 0), FILL_MIN_BOXES, FILL_MAX_BOXES)` | boxes filled | `5 → 1`, `20 → 2`, `50 → 3`, `70 → 4`, `100.01 → 5` (each floor boundary from below); live sanity points `5.59 → 1`, `14.04 → 1` | `4.99 → 0`, `19.99 → 1`, `49.99 → 2`, `69.99 → 3`, `100 → 4` (the first four one hair below their floor; `100` is the exclusive top floor itself) | R6 |
| C20 | tps formula | `1000 × Σ tokens.output / Σ (time.completed − time.streamed)` over counted assistant messages | tokens per second | one assistant message, `output 200`, `streamed 1000`, `completed 2000` → `tps = 200`; two messages `100` over 1000 ms and `100` over 3000 ms → `50` (the average of the two per-message rates would give `66.67`) | same message without `time.completed`, or without `tokens`, or with `completed === streamed` → `undefined` → 0 boxes | R6 |
| C21 | `barTone` | `filled > 0` → `"success"`, else `"muted"` | box colour class | `tps 5` → 1 box → `"success"`; `tps 300` → 5 boxes → `"success"` | `tps 4.99` → 0 boxes → `"muted"`; `tps 1000` (5 boxes) → never `"error"`; no `filled` value returns `"warning"` or `"error"` | R6 |
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
| C32 | `BUILTIN_AGENT_IDS` | `["build", "compaction", "explore", "general", "summary", "title"]` (host v2.2.6 registry) | host builtin classification only (A.8) | agent list `[general, explore, coder]` → charter mode, member roles `[coder]`, `M = 1`; `[general, coder]` → charter mode even when `coder` is hidden or primary (mode looks at the unfiltered custom list) | list `[build, general, explore, title]` → no custom id, built-in mode, member roles `[explore, general]` (build primary, title hidden+primary), `M = 2`; list `[general, title]` → built-in mode, member roles `[general]`, `M = 1`; the id `title` must not be mistaken for a custom definition | R1, R2 |
| C33 | `BUILTIN_TAG_TEXT` | `"[built-in]"` (10 cells) | the built-in role's model field text (A.9), never a model label; the field is `W−19` on the fallback path and C48's `M` on the proportional path (C50) | width 29 → model column 10 → tag whole: head `" 1.explore   [built-in] "` (24 cells); width 35 → tag plus 6 pad cells in the 16-cell column, head `" 1.explore   [built-in]       "` (30 cells) | width 28 → model column 9 → `clip("[built-in]", 9)` = `"[built-i…"` (9 cells), head `" 1.explore   [built-i… "` (23 cells); width 20 → column 1 → `"…"`, head `" 1.explore   … "` (15 cells); width 19 → column 0 → `""`, head `" 1.explore    "` (14 cells) | R2 |
| C34 | built-in tag slot rule | `built-in ? padCells(clip(BUILTIN_TAG_TEXT, F), F) : (model ? padCells(fitModel(label, min(F, ROLE_MODEL_MAX_CELLS)), F) : " ".repeat(F))`, where `F` is the role model field (fallback `W−19`, proportional C48's `M`) and built-in = `agent.id ∈ BUILTIN_AGENT_IDS` | which text fills the role model field (the field width itself comes from C48 or `ROLE_FIXED_CELLS`'s complement) | built-in `explore` at width 35 on the fallback path → `" 1.explore   [built-in]       "` + `"▓▓▓░░"` (35 cells); the same row with the host resolving `agent.model = "Go/Kimi K3.1 Pro"` renders the same tag string, not the label (A.9 decision 2) | member `coder` at width 35 with model `"Go/Kimi K3.1 Pro"` → `" 1.coder     Go/Kimi K3.1 Pro "` (30 cells), the A.5/C6 member string unchanged; a built-in **instance** row → `" └ Inspect… Go/Grok 4.7       "` (30 cells), model label when A.10 shows it (C35), no tag | R2, R5 |
| C35 | instance model visibility rule (A.10) | `shown = resolvedShort(instanceRef) !== resolvedShort(roleRef)`, with `resolvedShort(ref) = ref ? shortLabel(ref) : UNKNOWN_MODEL`; compared before any clip, cap or padding | whether the instance model column holds a label or is omitted | equal (member role): role `Go/Kimi K3.1 Pro`, instance resolves `Go/Kimi K3.1 Pro` → omitted, head `" └ Inspect…                   "` (30 cells: 3 + 8 + 1 + 17 + 1); the boxes still start in column 31 | differ: role `Go/Kimi K3.1 Pro`, instance `Go/Kimi K3.1 Pro Max` → shown as `" └ Inspect… Go/Kimi K3.…      "` (30 cells: 12-cell split text + 5 pad + 1 separator); a comparison made **after** clipping sees both as `Go/Kimi K3.…` and omits, so it fails the pin. Both unknown (role definition has no model, instance resolves none) → equal → omitted (F29). A temporary built-in role whose tag is shown but whose live definition model equals the instance's → omitted (T8); a role label longer than the 20-cell text cap still compares by its unclipped label and is omitted (T13); refs differing only by variant compare equal and are omitted (T14) | R3 |
| C36 | omitted-slot rule (A.10) | `shown ? padCells(fitModel(label, min(F, INSTANCE_MODEL_CELLS)), F) : " ".repeat(F)`, where `F` is the instance model field (§1.2: fallback `W−18`, proportional C49's `M`); the field width and the separator stay in both branches | content of the instance model field | omitted at W = 35 → 17 spaces, head 30 cells, separator the 30th cell, boxes 31–35; at W = 30 (field 12) → 12 spaces; at W = 29 (field 11) → 11 spaces; at W = 19 (field 1) → 1 space, head `" └ Inspect…   "` (14 cells), row 19 cells; at W = 28 proportional (field 11) → head `" └ Inspec…"` + 13 spaces (23 cells) | shown at W = 19 → `fitModel(label, 1)` falls to `clip(label, 1)` = `"…"`, head `" └ Inspect… … "` (14 cells, content differs from the 1-space slot); an implementation that drops the field or the separator when omitted yields a 13-cell head and shifts the boxes, and a reflow that widens the title breaks C11 | R3, R5 |

| C37 | `CELL_PX` | 8 | last-resort pixels per cell: the rung-3 divisor and the `cellPx` option's default. Rung 2 never reads it (C52) | 280 px at rung 3 → `280 / 8 = 35.0` → 35 cells; 288 → 36 | 260 px → 32.5 → 33 cells (half-up; a truncating or half-even rule gives 32); 259 px → 32.375 → 32; the option `cellPx: 10` at rung 3 with 360 px → 36 | R5 |
| C38 | `ROLE_REST_FIXED_CELLS` | 10 (number 3 + gap 1 + separator 1 + boxes 5) | role cells outside the proportional split | W 35 → rest 25 → name 10 + model 15 | W 24 → rest 14 → 6 + 8; W 19 → rest 9 (a floor binds, C48) | R5 |
| C39 | `INSTANCE_REST_FIXED_CELLS` | 10 (indent 3 + gap 1 + separator 1 + boxes 5) | instance cells outside the proportional split | W 35 → rest 25 → title 8 + model 17 | W 24 → rest 14 → 6 + 8; W 19 → rest 9 (a floor binds, C49) | R5 |
| C40 | `ROLE_NAME_SHARE_NUM` = 2, `ROLE_NAME_SHARE_DEN` = 5 | 2/5 of the rest | role name field share, rounded half-up | rest 25 → 10 (10.0); rest 27 → 11 (10.8); rest 40 → 16 (16.0) | rest 13 → 5 (5.2, below the C42 floor → fallback); rest 14 → 6 (5.6, first non-binding) | R5 |
| C41 | `INSTANCE_TITLE_SHARE_NUM` = 2, `INSTANCE_TITLE_SHARE_DEN` = 5 | 2/5 of the rest | instance title share, rounded half-up, then capped at 8 | rest 18 → 7 (7.2); rest 19 → 8 (7.6); rest 40 → 16 → capped 8 (C11) | rest 13 → 5 → title floor → fallback; rest 14 → 6 (5.6) | R5 |
| C42 | `ROLE_NAME_MIN_CELLS` | 6 | name field floor (proportional path) | rest 14 → name 6, split applies | rest 13 → name 5, fallback; T20 pins `" 1.designer  …/K… "` (18 cells) | R5 |
| C43 | `ROLE_MODEL_MIN_CELLS` | 4 | role model field floor | rest 14 → model 8 | rest 5 → name 2 and model 3 (synthetic: `W >= 19` gives `rest >= 9`, where the model is 5 and the name floor already binds, so this floor is a guard — the C16/C17 precedent) | R5 |
| C44 | `INSTANCE_TITLE_MIN_CELLS` | 6 | title field floor (proportional path) | rest 14 → title 6 | rest 13 → title 5 → fallback (instance twin of C42) | R5 |
| C45 | `INSTANCE_MODEL_MIN_CELLS` | 4 | instance model field floor | rest 14 → model 8 | rest 5 → title 2 and model 3 (synthetic, same guard as C43: at `rest 9` the model is 5 and the title floor binds first) | R5 |
| C46 | width ladder (rung selector) | `selectCells(probe, metrics, cellPxOption)`: shared gates (probe present, `placement === "side"`, `visible`, `opened`, `loaded`) or `undefined`; then rung 1 when `metrics.layoutCells` is finite and `> 0` → `roundHalfUp(layoutCells)`; else rung 2 when `runtimeCellPx(metrics)` is defined (C52) **and** `cssWidth` finite `> 0` → `roundHalfUp(cssWidth / runtimeCellPx)`; else rung 3 when `cssWidth` finite `> 0` → `roundHalfUp(cssWidth / resolveCellPx(cellPxOption))`; else `undefined`. First succeeding rung wins; ties round **up**. The option is read by rung 3 only | detected width in cells and the rung that produced it | rung 1: `{layoutCells 40}` → `cells 40, rung 1`; rung 2: `{resolutionWidth 1600, rendererColumns 200, cssWidth 280}` → `cells 35, rung 2`; rung 3: `{cssWidth 280}` with the option 8 → `cells 35, rung 3`; `{cssWidth 260}` → `cells 33` (32.5 rounds up) | all three present (`layoutCells 40`, resolution 1600/200, `cssWidth 280`) → `cells 40, rung 1`, never rung 2's 35; `{resolutionWidth 1600, rendererColumns 0, cssWidth 280}` → rung 2 skipped, rung 3 → `cells 35` (a divide-by-zero rung 2 yields `Infinity`/`NaN` and fails); `transition() === false`, `opened() === false`, `visible() === false`, `placement === "mobile"`, `cssWidth 0`, `cssWidth NaN`, or no probe (including a gui module unavailable at runtime, F38) → `undefined`, `dynamic = false` even when `layoutCells` is present | R5 |
| C47 | `rowWidth` rule (with C53) | `declared = max(MIN_ROW_CELLS, width ?? DEFAULT_WIDTH)`; `detected = selectCells(probe, metrics, cellPx)` (C46); rung-1 win → `W = clamp(detected.cells)`, `accepted = W`; else C53 stable box → `W = clamp(lastAccepted)`, `accepted = lastAccepted`, `rung 1`; else `W = detected === undefined ? declared : clamp(detected.cells)`, `accepted = undefined`; `clamp(x) = max(MIN_ROW_CELLS, min(declared, x))`. `lastAccepted` is C53's record; the rung changes no arithmetic | effective width and the next `lastAccepted` | declared 35, detected 50 → W 35 (cap); declared 35, detected 28 → W 28; declared 18 → 19; declared 40, detection 50 → `W 40, accepted 40` | declared 35, detected 12 → W 19 (floor, not 12); detected undefined and no stable box → 35; any rung-2/3 outcome returns `accepted undefined` | R5 |
| C48 | role split rule (A.11) | `rest = W − C38`; `N = roundHalfUp(rest × 2/5)`; `M = rest − N`; `dynamic && N >= 6 && M >= 4` → `N`/`M`, else the pre-A.11 `9 / (W − 19)` | role field sizes and the name text budget | W 35 dynamic → 10/15 → `" 1.explore    Go/Kimi K3.1 P… "` (30 cells); W 50 dynamic → 16/24 → `" 1.explore          Go/Kimi K3.1 Pro        "` (45 cells) | W 35 fallback → 9/16 → `" 1.explore   Go/Kimi K3.1 Pro "` (30 cells) at the same W; W 23 dynamic → floor → 9/4 → `" 1.designer  …/K… "` (18 cells) | R5 |
| C49 | instance split rule (A.11) | `rest = W − C39`; `share = roundHalfUp(rest × 2/5)`; `T = min(share, INSTANCE_TITLE_CELLS)`; `M = rest − T`; `dynamic && T >= 6 && M >= 4` → `T`/`M`, else the pre-A.11 `8 / (W − 18)` | title and model field sizes, and the unused-title-cells rule | W 28 dynamic → 7/11 → `" └ Inspec… Go/Grok 4.7 "` (23 cells); W 35 dynamic → 8/17 (identical to fallback); W 24 dynamic → 6/8 | W 28 fallback → 8/10 → `" └ Inspect… Go/Grok 4… "` (23 cells) at the same W; W 23 dynamic → floor → 8/5 | R5 |
| C50 | built-in tag in the derived role model field | `padCells(clip(BUILTIN_TAG_TEXT, M), M)` where `M` is C48's model field on the proportional path and `W − 19` on the fallback path; the tag's 10 cells are its own cap, `ROLE_MODEL_MAX_CELLS` never applies | tag text and its field | W 26 dynamic → M 10 → `" 1.explo… [built-in] "` (21 cells); W 35 dynamic → M 15 → `" 1.explore    [built-in]      "` (30 cells) | W 25 dynamic → M 9 → `" 1.explo… [built-i… "` (20 cells); W 28 fallback → field 9 → `" 1.explore   [built-i… "` (23 cells) | R2, R5 |
| C51 | rung-1 layout read (renderer tree) | host-side rule, injected into the pure layer as `layoutCells`, plus `boxCells` (both projected from **one** read of `A.width`) and `rowsCells` (a **separate** getter read of `P.width` in the same pass): `P` = the full-mode panel's outer `<text>` renderable (captured by `ref`), `A = P.parent`; authoritative iff `P` and `A` exist, `A !== renderer.root`, `Number.isFinite(A.width)`, `A.width > 0`, and `A.width > P.width` (strict); value = `A.width`. Otherwise `undefined`. Read per pass, never stored as a width; a throw is caught and yields `undefined`, never a toast | `metrics.layoutCells` and `boxCells` are one read of the ancestor's width; `metrics.rowsCells` is the panel node's own width, read separately (never `A.width`) | `A.width 40`, `P.width 35` → 40; `A.width 36`, `P.width 35` → 36 (the one-cell strict edge); `A.width 40` while a resolution reading would have said 35 → rung 1 wins with 40 | `A.width 35`, `P.width 35` → `undefined` (equality is not authority; it is C53's stable box, which keeps the recorded width only against a valid record); `A.width 30`, `P.width 35` → `undefined` (rows overflow the slot box → rung 2/3 read the pane); `A === renderer.root` → `undefined`; node unmounted (compact mode, closed sidebar, first pass) → `undefined`; non-finite or `<= 0` ancestor width → `undefined`; a throwing `width`/`parent` getter → `undefined`; `rowsCells` set from `A.width` → equality always true and T24's equality-without-record case fails | R5 |
| C52 | `runtimeCellPx` | `resolutionWidth / rendererColumns`, using `PixelResolution.width` (device px, `renderer.resolution`) and `CliRenderer.width` (terminal columns); defined iff both are finite and `> 0` | device pixels per terminal cell, the rung-2 divisor | 1600 px / 200 columns → 8 → 280 CSS px → 35 cells; 1000 / 120 → 8.333… → 250 px → 30 cells | `resolution === null` (terminal reports no pixel-resolution escape) → `undefined`; `rendererColumns 0` → `undefined`; `resolutionWidth 0` → `undefined`; `rendererColumns NaN` → `undefined` | R5 |
| C53 | stable-box dampener | `stable = gates && boxCells === rowsCells && lastAccepted !== undefined && lastAccepted === rowsCells` (the `gates` are C46's); when stable (and rung 1 is not strictly wider) `rowWidth` keeps `W = clamp(lastAccepted)`, reports `rung 1`, and returns `accepted = lastAccepted`; every other outcome returns `accepted = undefined`, which clears the record. The record is written only by a strict rung-1 win (`accepted = W`), lives in the TUI for one activation, is never persisted, never a signal, and is revalidated against the rows' width before use | the `lastAccepted` record (one number), and the absence of a rung-1 ↔ rung-2 cycle | declared 40, two passes: pass 1 rows 35, box 40, `lastAccepted undefined` → rung 1, `W 40, accepted 40`; pass 2 rows 40, box 40, `lastAccepted 40` → stable, `W 40, accepted 40` (same result, no rung-2 consult) | rows 40, box 40, `lastAccepted 35` (stale: not the rows' width) → not stable → rung 2's value, `accepted undefined`; rows 35, box 30 (shrink) with `lastAccepted 40` → not stable → rung 2, record cleared; rows 40, box 40, `lastAccepted undefined` (a fallback-path pass invented no record) → not stable → rung 2; probe gates fail → no stable box | R5 |

C32 is a set-membership boundary, not a width. The fits side is "the list has
at least one id outside the set"; the does-not-fit side is "every id is in the
set". The set must contain every host builtin, including hidden and primary
ones: a missing id (for example `title`) would make every session look like a
charter session. The value is the host registry the plugin ships against; a
host version that adds a builtin id updates this constant and its fixtures in
the same commit (F26).

C35's comparison is text equality, not ref equality: both sides run through
the one `resolvedShort` helper, so two different refs that produce the same
short label (including two refs that differ only by `variant`, which the short
label drops, R8) compare equal and the cell is omitted (F30). "Before any
clipping" means before `fitModel`, before the model text cap (C36's
`min(M, INSTANCE_MODEL_CELLS)`, C34's `min(F, ROLE_MODEL_MAX_CELLS)`), before
padding and before the role name clip: the operands are the unclipped
`shortLabel` strings. The C35 does-not-fit fixture discriminates this: role
`Go/Kimi K3.1 Pro` and instance `Go/Kimi K3.1 Pro Max` both clip to
`Go/Kimi K3.…`, so a post-clip comparison would wrongly omit the label.

Unknown vs unknown (C35, F29). `resolvedShort(undefined)` is
`UNKNOWN_MODEL` on both sides, so a role with no definition model and an
instance that resolves no model compare **equal** and the model cell is
omitted. The information content is nil: the role row is already blank in that
column, and two `unknown model` strings would add no distinguishing fact.
Product's two clauses collide here ("or when the instance's model is unknown"
against "When the labels agree, the model cell is omitted"); the design takes
the omit branch and records it as F29, settled by PM arbitration. The asymmetric case is
not ambiguous: an unknown instance label against a **known** role label
differs, so the cell renders `unknown mod…` (T9's twin, T10's inverse).

C19's `5.59` and `14.04` are the two real speeds observed in the live R6
diagnostic (D1); which session they came from does not matter. They are sanity
points, not boundaries: `5.59` clears the `5` floor, and `14.04` clears `5`
while staying below `20` (A.7). The boundaries themselves are pinned by the
exact floor values and the one-hair-below values in the row.

One constant, one meaning, checked at the places the numbers collide:

- `FILL_BANDS` is the only fill table: it owns the band floors. Floors 1–4 are
  inclusive and each maps to boxes 1–4; floor 5 is exclusive and adds box 5
  only when `tps` is strictly above it (A.7). `FILL_MIN_BOXES` and
  `FILL_MAX_BOXES` survive as the clamps and own only the fill range. The `5`
  in `FILL_MAX_BOXES` coincides with `BAR_CELLS` and with `FILL_BANDS.length`
  by construction only: three fields, three constants, none derived from
  another at a call site. With five bands the count never exceeds
  `FILL_BANDS.length`, so both clamps are guards rather than binding limits:
  the invariant assert is what pins the range.
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
- `BUILTIN_AGENT_IDS` (C32) owns the host builtin classification only. It is
  not a row count, not a width, and never feeds `M` directly; `M` is
  `members.roles.length` after `isVisibleRole` (A.8).
- `BUILTIN_TAG_TEXT` (C33) is the tag's only source of both text and width
  (10 cells by `cellWidth`); it is not a model label, never passes through
  `fitModel`, and is not capped by `ROLE_MODEL_MAX_CELLS` (a second field's
  constant). The slot it fills is `ROLE_FIXED_CELLS`'s existing complement, so
  no width constant is added for it (C34, A.9).
- `UNKNOWN_MODEL` (C27) stays the single spelling of "no model known". The
  A.10 comparison maps both operands through one `resolvedShort` helper, so
  the constant is read in one place for one field (the resolved-label text);
  no second unknown-model constant is introduced, and the role baseline never
  reuses `BUILTIN_TAG_TEXT` or the role column width (C35). `INSTANCE_MODEL_CELLS`
  (12) still caps the label **text** when it is shown; the omitted slot is
  padding in the same `INSTANCE_FIXED_CELLS` complement, so no new width
  constant exists for it (C36).
- `ROLE_REST_FIXED_CELLS` (10) and `INSTANCE_REST_FIXED_CELLS` (10) are two
  constants for two fields — the role split budget and the instance split
  budget. They are equal by construction, never interchangeable (the A.5
  separator precedent). Neither is `ROLE_FIXED_CELLS`/`INSTANCE_FIXED_CELLS`:
  those stay the fallback totals (19/18) and are not reused as dynamic rest
  values.
- `ROLE_NAME_SHARE_NUM`/`_DEN` and `INSTANCE_TITLE_SHARE_NUM`/`_DEN` are two
  shares for two fields, each 2/5 by construction. A share is a multiplier on
  the rest, not a width; the resulting `N` and `T` are the fields (C40, C41).
- The four floors — `ROLE_NAME_MIN_CELLS` (6), `ROLE_MODEL_MIN_CELLS` (4),
  `INSTANCE_TITLE_MIN_CELLS` (6), `INSTANCE_MODEL_MIN_CELLS` (4) — are one per
  field. The 6/6 and 4/4 coincidences are construction only. None may be
  replaced by `INSTANCE_TITLE_CELLS` (a cap, not a floor), by
  `ROLE_NAME_CELLS` (the fallback name cap), or by a bare literal.
- `CELL_PX` (8, C37) is the rung-3 divisor only. It is not a cell width
  (§0's `cellWidth`), not `DEFAULT_WIDTH`, and never a field size: `width` is
  a cell count, `cellPx` a pixel count, and the rung-3 conversion happens once
  in C46. Rung 2's divisor is `runtimeCellPx` (C52), derived per pass from the
  renderer, and the two divisors never substitute for each other: the option
  is read by rung 3, the renderer by rung 2.

A.11 fixture contract. Each of C37–C50 carries a fits and a does-not-fit
fixture in its row, and every A.11 row string is pinned through `panel()` with
the proportional flag set, never through a TUI string. **Every fixture states
its path** (`dynamic` or `fallback`), and a same-`W` pair with two different
exact strings is legitimate and expected, not a contradiction (F32, settled):
at W 35 the role head is `" 1.explore    Go/Kimi K3.1 P… "` on the dynamic
path and `" 1.explore   Go/Kimi K3.1 Pro "` on the fallback path. C1, C2 and
the C5–C36 row strings keep their pre-A.11 fixtures on the fallback path
(`dynamic = false`, the default), so no existing fixture changes. The boundary
set a dynamic fixture must cover: rest 13/14 (floor edge, W 23/24), model
field 9/10 (tag edge, W 25/26), declared vs detected on both sides of the cap,
a detected width below the floor (12 → 19), W 35 (two paths at one width),
W 50 (name field above the 9-cell fallback cap), and one live width change
(T21). T15–T23 pin those values. T1–T14 and S1–S12 stay fallback-path fixtures
(`dynamic = false`); none of them pins a proportional row, and their instance
geometry coincides with the proportional path only from `W = 29` up, where
`T = 8` and `M = W − 18` on both paths.

A.12 fixture contract. The top of the ladder moved; the field arithmetic did
not. Every A.11 fixture passes **no `RuntimeMetrics`**, so it resolves through
rung 3 with the same `cellPx` option and keeps its exact values byte for byte:
T15–T23 are unchanged and are labelled rung 3 by the new contract, and C47's
cap/floor fixtures are unchanged. C51 and C52 take injected readings in the
pure layer (`layoutCells`, `boxCells`, `rowsCells`, `resolutionWidth`,
`rendererColumns`) and are pinned
with exact selector values, not row strings: the four combinations (layout
available; resolution available; sidebar px only; nothing) each have a fits and
a does-not-fit fixture, and C46's row carries the cross-rung discriminators
(layout beats resolution at the same input, a zero column count falls through
to rung 3). T24 pins rung 1 through `rowWidth` (`W`, `rung`, `accepted`), pins
C53's dampener as two consecutive passes with the same result, pins the stale
record and the shrink clearing it, and pins the record as the **adopted** width
(19 at the floor, not 12). T25 pins rung 2
against rung 3 with one sidebar pixel width and two divisors, including the
`cellPx` option being read by rung 3 only. No A.12 fixture invents a TUI string
and no existing string is re-measured.

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

C8 recomputation (fallback-path width ladder), pinned — `ROLE_FIXED_CELLS = 19`,
so on the fallback path the role model column is `W − 19` and the head is
`W − 5` at every width (the proportional path's ladder is §1.4):

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

- Title `Project Team Members 1/5` for five member roles and one active.
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
- Speed bar glyphs at width 35, `filled = 3` (C19: `tps` from `50` up to below
  `70`; the floors read `5 → 1`, `20 → 2`, `50 → 3`, `70 → 4`, `100 → 4`,
  `100.01 → 5`): the role row
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

### A.8 member-selection scenarios (exact values)

Each scenario is a full `panel()` pass at width 35 with no overflow unless
stated. `S` is the member snapshot; `A` is the live agent list; `sessions`
are in the viewed tab.

- **S1 — charter snapshot and stable `M`.** `S = memberSet([build(primary),
  general(subagent), explore(subagent), coder(subagent), designer(subagent)])`
  → `mode = "charter"`, roles `[coder, designer]`, `M = 2`. With no sessions:
  title `Project Team Members 0/2`, rows ` 1.coder` and ` 2.designer` (idle,
  alphabetical), `more = 0`. Later `A` gains `helper` and a `helper` session
  runs: no `helper` row, `total` stays 2. Later `coder` is deleted from `A`:
  the `coder` idle row stays (snapshot definition), `total` stays 2.
- **S2 — built-in mode idle rows.** `A = [build(primary),
  general(subagent), explore(subagent), title(hidden, primary),
  summary(hidden, primary), compaction(hidden, primary)]` → no custom id,
  `mode = "builtin"`, roles `[explore, general]`, `M = 2`. Rows are the two
  idle builtins in name order; `build`, `title`, `summary` and `compaction`
  have no row.
- **S3 — charter suppresses builtin idle rows.** `A = [general, explore,
  coder]` → charter mode, roles `[coder]`, `M = 1`. Title `Project Team
  Members 0/1`; exactly one row, ` 1.coder`. `general` and `explore` have no
  idle row.
- **S4 — temporary builtin and member both work.** Same `S` as S3, plus a
  running in-scope `general` child at 1000 (title `Audit`) and a running
  in-scope `coder` child at 2000 (title `Check`). The `general` temporary
  role's baseline is its live definition model and the `coder` role's baseline
  is its snapshot model; neither child has an own or ancestor model, so R8
  step 2 resolves each child to the same definition model its role baseline
  uses (no mid-session definition change), both label pairs agree, and A.10
  omits both model cells (C35/F29). `mode = "charter"`,
  `M = 1`; both roles have a working instance, so `N = 2` → title
  `Project Team Members 2/1`. Busy order by oldest instance: `general` at 1000
  before `coder` at 2000. Rows: ` 1.general` (active, definition colour),
  `" └ Audit                      "` (30 cells: no model cell, C35/F29),
  ` 2.coder` (active), `" └ Check                      "` (30 cells, same).
  `total` did not move.
- **S5 — succeeded temporary removes both.** S3 plus one running in-scope
  `general` child at 1000; then it is no longer running and is not grace
  (succeeded): no instance row and no `general` row. `N = 0`, `M = 1`; rows:
  ` 1.coder` idle only; title `Project Team Members 0/1`.
- **S6 — failed temporary keeps both for exactly 30 s.** S3 plus one running
  in-scope `general` child at 1000; then it ends `outcome: failed` with
  `time.updated = T`. At `now − T = 29_999`: `general` is a grace role with
  one `└` grace instance, warning text, empty boxes; `coder` idle is second;
  `N = 0`, `M = 1`, title `Project Team Members 0/1`. At `now − T = 30_000`:
  both `general` rows are gone, `coder` is ` 1.coder`, title unchanged. This is
  the temporary-row twin of C22.
- **S7 — several temporary rows and a member.** `M = 1` (`coder`), with
  running in-scope instances `explore` at 1000, `general` at 2000 and `coder`
  at 3000. Busy order is `explore`, `general`, `coder`; numbers ` 1.` to
  ` 3.`; `N = 3`, `M = 1`, title `Project Team Members 3/1`.
- **S8 — non-member custom is invisible.** Charter snapshot `[coder]`; later
  a `helper` definition appears and its in-scope child runs. No `helper`
  section and no `helper` instance row; `N` counts only real sections, `M`
  stays 1. The exception is builtin-only.
- **S9 — built-in mode ignores a custom runner.** Built-in snapshot from
  `[general, explore]`, `M = 2`. Later `coder` appears in `A` and runs: no
  `coder` row, `total` stays 2.
- **S10 — a temporary section folds whole.** Member `A` with 7 instances
  (8 lines), then a temporary `general` with 2 instances (3 lines), then idle
  member `B`. The body stops before `general`: 8 lines emitted, `more = 4`
  (3 for `general` + 1 for `B`), no `general` row. `M` still counts `A` and
  `B` (folded roles consume no number).
- **S11 — C32 boundary.** `memberSet([general])` → builtin, `[general]`,
  `M = 1`. `memberSet([general, coder])` → charter, `[coder]`, `M = 1`.
  `memberSet([title])` → builtin, `[]`, `M = 0`. `memberSet([general,
  helper(primary)])` → charter (custom exists), `[]`, `M = 0`; the panel
  hides at `total = 0` even if `general` runs (F27).
- **S12 — snapshot boundary.** Snapshot `[general, coder]` → charter, `M = 1`.
  Before the next activation: delete `coder`, add `designer`, run `general`
  and `designer`. Mode stays charter, `coder` remains a row, `designer` has
  no row, `general` has a temporary row. Next plugin activation with
  `[general, designer]` → still charter, roles `[designer]`, `M = 1`.

### A.9 built-in tag scenarios (exact values)

Width 35 unless stated; the built-in rows use `BUILTIN_TAG_TEXT` (C33) in the
16-cell model column, so their heads carry the tag plus 6 pad cells plus the
separator (7 spaces after `]`).

- **T1 — permanent built-in rows in built-in mode.** `A = [build(primary),
  general(subagent), explore(subagent), title(hidden, primary)]` → built-in
  mode, roles `[explore, general]`, `M = 2`. Idle rows:
  `" 1.explore   [built-in]       "` + `"░░░░░"` and
  `" 2.general   [built-in]       "` + `"░░░░░"`.
- **T2 — temporary built-in row in charter mode; its instance keeps the
  model.** Snapshot `[coder]` with a running in-scope `general` child at 1000
  (title `Audit`, model `Go/Grok 4.7`) and idle member `coder` with model
  `Go/Kimi K3.1 Pro`. Rows: `" 1.general   [built-in]       "` + `"░░░░░"`
  (or `"▓▓▓░░"` for a working speed above 50), then
  `" └ Audit    Go/Grok 4.7       "` + its own bar, then
  `" 2.coder     Go/Kimi K3.1 Pro "` + `"░░░░░"`. The built-in role row shows
  the tag; its instance row shows the model and no tag.
- **T3 — a live definition model is ignored on a built-in role row (A.9
  decision 2).** The T1 `explore` entry carries `model = "Go/Kimi K3.1 Pro"`:
  the row is still `" 1.explore   [built-in]       "`, while the same 16-cell
  label on the member `coder` renders `" 2.coder     Go/Kimi K3.1 Pro "`.
- **T4 — the name clip never eats the tag (A.9 decision 4).** Built-in name
  `"1234567890"` (10 cells) → `clip` gives `"12345678…"` (9 cells, C5) and the
  head is `" 1.12345678… [built-in]       "` (30 cells): one `ROLE_NAME_GAP_CELLS`
  space, the whole tag, 6 pad, 1 separator. Dynamic twin at the same width
  (`N = 10`, C48): the 10-cell name fits whole, head
  `" 1.1234567890 [built-in]      "` (30 cells: gap 1, tag 10, 5 pad,
  1 separator).
- **T5 — width pressure on the tag (C33).** Same built-in row at width 29:
  `" 1.explore   [built-in] "` (24 cells, no pad); at width 28:
  `" 1.explore   [built-i… "` (23 cells); at the `MIN_ROW_CELLS` floor 19:
  `" 1.explore    "` (14 cells, empty slot, separator kept). A member row at
  width 28 keeps the model rule and never shows the tag:
  `" 1.coder     Go/Kimi … "` (23 cells: budget 9 gives provider `Go` plus
  `/` plus `Kimi …`, filling the 9-cell column exactly).

### A.10 instance-model scenarios (exact values)

Width 35 unless stated. Both operands are the unclipped short labels (C35);
the instance row uses `└` when it is the only instance of its role (C10).
Every head below is 30 cells at width 35, so every row is 35 cells with its
5 boxes in columns 31–35; T11 lowers the width and T13 raises it, and both
state their own heads.

- **T6 — equal models, member role: the cell is omitted.** Charter snapshot
  `[coder]` with `coder.model = "Go/Kimi K3.1 Pro"`; one running in-scope
  coder child at 1000, title `Inspect modules`, no own model, no ancestor
  model, so R8 step 2 resolves the live definition `Go/Kimi K3.1 Pro`; the
  baseline is the snapshot's `Go/Kimi K3.1 Pro`. Equal → omitted. At
  50 tokens/sec: role `" 1.coder     Go/Kimi K3.1 Pro "` + `"▓▓▓░░"`, instance
  `" └ Inspect…                   "` + `"▓▓▓░░"`. The instance head is 3 indent
  + 8 title + 1 gap + 17 blank model-column cells + 1 separator = 30; the
  boxes start in column 31.
- **T7 — differing models, member role: the cell renders.** Same role; the
  child has its own session model `Go/Grok 4.7`, so R8 step 1 wins and the
  labels differ. Instance `" └ Inspect… Go/Grok 4.7       "` + `"▓▓▓░░"`
  (11-cell label + 6 pad + 1 separator after the title gap). Discriminator:
  with its own session model `Go/Kimi K3.1 Pro Max`, the label still renders
  — `" └ Inspect… Go/Kimi K3.…      "` (the 12-cell split text + 5 pad + 1
  separator) — because the comparison happens before clipping; both labels
  clip to `Go/Kimi K3.…`, so a post-clip comparison would omit and fail.
- **T8 — temporary built-in with a definition model: equal, so omitted; the
  tag is not the baseline.** Charter snapshot `[coder]`; live `general`
  definition model `Go/Grok 4.7`; one running in-scope `general` child,
  title `Audit`, no own/ancestor model → R8 step 2 gives `Go/Grok 4.7`; the
  role baseline is the same live definition model → omitted, even though the
  role row displays the tag. Rows: `" 1.general   [built-in]       "` + its
  bar, then `" └ Audit                      "` + its bar (3 + 8 + 1 + 17 + 1;
  19 spaces after the padded title). Differing twin: the child's own session
  model is `Go/Kimi K3.1 Pro` → `" └ Audit    Go/Kimi K3.…      "`
  (4 spaces after `Audit`, the 12-cell split text, 5 pad, 1 separator).
- **T9 — unknown == unknown: equal, so omitted.** Charter snapshot `[coder]`
  with no `coder.model`; one running coder child with no own/ancestor model
  and no live definition model → R8 fallback `UNKNOWN_MODEL`; baseline
  `UNKNOWN_MODEL`. Equal → omitted. Role `" 1.coder                      "`
  (30 cells: 22 spaces after `coder`) + `"░░░░░"`; instance
  `" └ Inspect…                   "` + its bar. This is the F29 case.
  Asymmetric twin: baseline known (`Go/Kimi K3.1 Pro`), instance unknown →
  the cell renders `" └ Inspect… unknown mod…      "` (12-cell clipped unknown
  text + 5 pad + 1 separator).
- **T10 — instance resolves while the role model is missing: renders.** Same
  `coder` with no definition model (baseline `UNKNOWN_MODEL`); the child has
  its own session model `Go/Grok 4.7` → differs → `" └ Inspect… Go/Grok 4.7       "`.
  Role row stays `" 1.coder                      "`. Churn twin: on a later
  pass the member definition gains `Go/Grok 4.7` (next snapshot only, A.8),
  the labels agree, and the same row loses the cell — no grace, no timer, no
  stored flag.
- **T11 — width pressure on the filler slot (C36).** Omitted label at width
  29: head `" └ Inspect…             "` (24 cells: 13 spaces after the title).
  At width 19 (column 1): head `" └ Inspect…   "` (14 cells: gap 1 + 1 blank
  cell + separator 1), row `" └ Inspect…   "` + `"░░░░░"` = 19 cells. Shown
  label at width 19: `fitModel(label, 1)` falls to `clip(label, 1)` = `"…"`,
  head `" └ Inspect… … "` (14 cells) — same geometry, different content, so
  the boxes stay in columns 15–19 either way. The title field is 8 cells in
  every one of these rows (C11).
- **T12 — mixed rows keep the bar aligned.** Same role as T6 with two
  instances: at 1000 title `Inspect modules`, no own model (equal → omitted);
  at 2000 title `Audit`, own model `Go/Grok 4.7` (differs → shown). Rows:
  role `" 1.coder     Go/Kimi K3.1 Pro "`, then
  `" ├ Inspect…                   "`, then
  `" └ Audit    Go/Grok 4.7       "`. All three heads are 30 cells and all
  three bars occupy columns 31–35: the omitted row and the shown row keep the
  separator in the same column, which is R5's last-5-columns invariant.
- **T13 — the role rendering cap is not the comparison operand.** Width 40
  (role column 21, instance column 22). Charter snapshot `[coder]` with
  `coder.model` whose short label is `Go/Kimi K3.1 Pro Maxx` (21 cells); one
  running in-scope coder child at 1000, title `Inspect modules`, resolving the
  **same ref** (own session model absent, live definition identical), at
  50 tokens/sec.
  `ROLE_MODEL_MAX_CELLS` caps the role text to `fitModel(label, 20)` =
  `Go/Kimi K3.1 Pro Ma…` (20 cells) and the column pads it to 21, but the
  comparison uses the unclipped 21-cell short label on both sides → equal →
  omitted. Role `" 1.coder     Go/Kimi K3.1 Pro Ma…  "` (35 cells: 3 + 9 + 1 +
  21 + 1) + `"▓▓▓░░"`; instance `" └ Inspect…                        "`
  (35 cells: 3 + 8 + 1 + 22 + 1; 24 spaces after the title) + `"▓▓▓░░"`.
  Row 40 cells, boxes 36–40. A comparison against the rendered or capped text
  (20 cells) would differ from the 21-cell resolved label and wrongly show
  the instance label; the fixture fails that.
- **T14 — variant-only difference compares equal.** Width 35. The role
  definition ref is `{ providerID: "go", id: "kimi", variant: "high" }`,
  whose R8 full label is `Go/Kimi K3.1 Pro (high)` and whose short label is
  `Go/Kimi K3.1 Pro`; the running in-scope coder child (50 tokens/sec) owns the ref
  `{ providerID: "go", id: "kimi" }`, full label `Go/Kimi K3.1 Pro`, short
  label `Go/Kimi K3.1 Pro`. The short labels are identical, so the cell is
  omitted (F30). Role `" 1.coder     Go/Kimi K3.1 Pro "` + `"▓▓▓░░"`,
  instance `" └ Inspect…                   "` + `"▓▓▓░░"`. A ref-identity
  comparison would see the variant and show the label; the fixture fails
  that. The full labels differ, which is why this fixture also pins that the
  operand is the short label, not the full one.

### A.11 dynamic-width scenarios (exact values)

`dynamic = false` unless a scenario says otherwise; `W` is the effective width
from §1.4. Charter snapshot `[coder]` or member `explore` with model
`Go/Kimi K3.1 Pro`; bars are 3 filled unless stated. Every head below is
`W − 5` cells and the boxes are the last 5 columns.

- **T15 — proportional role split at W 35 (C48).** Member `explore`, model
  `Go/Kimi K3.1 Pro`, detection at 280 px with `cellPx 8` → `W 35`,
  rest 25, `N 10`, `M 15`. The 16-cell label splits at 15 to
  `Go/Kimi K3.1 P…` → head `" 1.explore    Go/Kimi K3.1 P… "` (30 cells:
  4 spaces after `explore`, 15-cell label, separator) + `"▓▓▓░░"` = 35 cells.
  Fallback twin at the same width: `" 1.explore   Go/Kimi K3.1 Pro "` (30).
- **T16 — cap and narrowing (C47).**
  - declared 35, detected 50 (400 px) → `W 35`, `dynamic = true` → T15's
    string: detection can only narrow.
  - declared 40, detected 50 → `W 40`, rest 30, `N 12`, `M 18`; the 16-cell
    label fits with 2 pad → head `" 1.explore      Go/Kimi K3.1 Pro   "`
    (35 cells: 6 spaces after `explore`, 2 pad + 1 separator after the label).
  - declared 35, detected 28 (224 px) → `W 28`, rest 18, `N 7`, `M 11`; the
    label splits to `Go/Kimi K3…` (11) → head `" 1.explore Go/Kimi K3… "`
    (23 cells).
- **T17 — tag edge at W 28 (C50).** Built-in `explore`:
  - fallback (`dynamic = false`) → 9-cell field → `clip` gives `"[built-i…"`,
    head `" 1.explore   [built-i… "` (23 cells).
  - detection at 224 px → `W 28`, `N 7`, `M 11` → tag whole with 1 pad, head
    `" 1.explore [built-in]  "` (23 cells: tag 10, 1 pad, 1 separator).
  The two rows are the same width and differ only in field sizes and text.
- **T18 — proportional instance split at W 28 (C49).** Title
  `Inspect modules`, shown label `Go/Grok 4.7` (11 cells):
  - detection at 224 px → rest 18, `T 7`, `M 11` → title `"Inspec…"`, label
    fits → head `" └ Inspec… Go/Grok 4.7 "` (23 cells).
  - fallback → `T 8`, field 10 → label splits to `Go/Grok 4…` → head
    `" └ Inspect… Go/Grok 4… "` (23 cells).
- **T19 — title cap and unused cells (C49).** Title `Inspect modules`, shown
  label `Go/Grok 4.7`:
  - `W 35` → rest 25, share 10, `T = min(10, 8) = 8`, `M = 17`: the 2 unused
    share cells go to the model field, so the head is
    `" └ Inspect… Go/Grok 4.7       "` (30 cells), identical to the fallback
    row.
  - `W 50` → rest 40, share 16, `T 8`, `M = 40 − 8 = 32` (8 unused cells to
    the model), head `" └ Inspect… Go/Grok 4.7"` + 22 spaces (21 pad + 1
    separator) = 45 cells.
  - Discriminator: an implementation that leaves the title field at the
    uncapped share (16 at W 50) keeps `M` at 24 and starts the label 8 cells
    later; the pinned string fails it.
- **T20 — floor binds, fallback arithmetic at W 23 (C42, C48).** Member
  `designer` with model `Go/Kimi`, detection at 184 px → `W 23`, rest 13,
  share 5. `N 5 < 6` → fallback: 9-cell name, 4-cell field, label splits to
  `…/K…` → head `" 1.designer  …/K… "` (18 cells). If the split were applied
  anyway the head is `" 1.desi… Go/Kimi  "` (18 cells: 5-cell name, 8-cell
  field) — same width, different content, so the fixture discriminates.
- **T21 — a live width change rebuilds rows, nothing else.** A member role
  with one active instance (50 tps → `filled 3`) and one grace instance, read
  at `W 35` and then at `W 50` (sidebar resized by 120 px). Both passes:
  `working`, `total`, `more`, numbering, order, every `filled`, every `tps`
  and every row `state` are identical; the grace row is still grace at
  `now − ended = 29 999` in both passes. Only the heads change: role
  30 → 45 cells, instance 30 → 45 cells, bars 31–35 → 46–50. No timer starts,
  stops, or re-reads `now`; no grace window moves.
- **T22 — detection unavailable (C46).** Declared 35, member `explore` with
  `Go/Kimi K3.1 Pro`. Each probe below yields `detected = undefined`,
  `dynamic = false`, and the same head `" 1.explore   Go/Kimi K3.1 Pro "`:
  no probe (a slot outside `Panel.render`, e.g. `prompt.footer`);
  `transition() === false` (stored width not loaded); `opened() === false`;
  `visible() === false`; `placement === "mobile"`; `cssWidth 0`; `cssWidth
  NaN`. Only `{side, visible, opened, loaded, 280}` reaches T15's dynamic row.
- **T23 — the name budget is the full field (C5, C48, F31 settled).** Member
  `design-review` (13 cells) with model `Go/Kimi K3.1 Pro`, detected 280 px →
  `W 35`, `N 10`, `M 15`. The name clips to `"design-re…"` (10 cells), the
  label splits at 15 to `Go/Kimi K3.1 P…`, head
  `" 1.design-re… Go/Kimi K3.1 P… "` (30 cells) + 5 boxes. Fallback twin at
  the same width: 9-cell name `"design-r…"` and 16-cell field
  `Go/Kimi K3.1 Pro` → head `" 1.design-r… Go/Kimi K3.1 Pro "` (30 cells).
  At `W 50` (`N 16`) the same 13-cell name renders whole with 3 pad cells. An
  implementation that still clips the name at 9 emits
  `" 1.design-r… Go/Kimi K3.1 P… "` (29 cells) and fails the 30-cell pin.

A.11's T15–T23 pass no `RuntimeMetrics`, so every one of them resolves at
rung 3 and keeps the value quoted above; they are rung-3 fixtures under A.12.

### A.12 three-rung width scenarios (exact values)

Selector-level fixtures: `rowWidth` and `selectCells` are called with injected
readings. `declared` is the configured `width`; the gates are
`{placement: "side", visible: true, opened: true, loaded: true}` unless stated.
`lastAccepted` is C53's injected record (`undefined` when the fixture starts
from a fresh activation); `accepted` is `rowWidth`'s next record.

- **T24 — rung 1 wins, then the cap, the floor, and the dampener (C51, C46,
  C47, C53).**
  - declared 40, `{layoutCells 50}` → `selectCells = {cells 50, rung 1}`,
    `rowWidth = {W 40, dynamic: true, rung: 1, accepted: 40}`: rung 1 measures
    the slot box (50) and the configured width caps it. The row is T16's
    declared-40 string `" 1.explore      Go/Kimi K3.1 Pro   "` (35 cells), i.e.
    rung 1 and rung 3 can produce identical rows; only the selector value tells
    them apart.
  - declared 40, `{layoutCells 36}` with rows at 35 (`A.width - P.width = 1`) →
    `{cells 36, rung 1}`, `W 36, accepted 36`: the strict `>` edge is the
    smallest accepted ancestor.
  - declared 40, `{layoutCells 28}` → `{W 28, rung 1, accepted 28}`, row
    `" 1.explore Go/Kimi K3… "` (23 cells, T16's narrowing case).
  - declared 40, `{layoutCells 12}` → `{W 19, rung 1, accepted 19}` (floor, not
    12; the record is the adopted width, so it is 19, not 12).
  - **dampener stability (C53), two passes, same result.** Declared 40.
    Pass 1: rows 35, `boxCells 40`, `rowsCells 35`, `lastAccepted undefined`,
    `layoutCells 40` → rung 1, `W 40`, `accepted 40`. Pass 2: rows 40,
    `boxCells 40`, `rowsCells 40`, `layoutCells undefined` (the box only equals
    the rows now), `lastAccepted 40` → stable box, `rung 1`, `W 40`,
    `accepted 40`. Both passes render the 40-cell row; the pins are
    `{W 40, rung 1}` twice, which is the absence-of-oscillation fixture. An
    implementation without the record consults rung 2 on pass 2 and (with
    `cssWidth 360`, resolution 1600, 100 columns → 23 cells) drifts to `W 23`
    and back, failing the second pin.
  - **stale dampener falls.** Rows 40, `boxCells 40`, `rowsCells 40`,
    `lastAccepted 35` (not the rows' width) → not stable → rung 2 with
    `cssWidth 360`, resolution 1600, 100 columns → `{cells 23, rung 2}`, `W 23`,
    `accepted undefined`. An implementation that trusts any record keeps 35 and
    fails the `W 23` pin.
  - **shrink clears.** Rows 35, `boxCells 30`, `rowsCells 35`, `lastAccepted 40`
    → not a win (30 < 35) and not stable (30 ≠ 35) → rung 2 → `{cells 23,
    rung 2}`, `W 23`, `accepted undefined`: shrink detection still works and the
    record cannot survive it.
  - equality without a record falls: rows 35 in a 35-cell slot box
    (`layoutCells undefined`) with `cssWidth 360`, resolution 1600 px and
    terminal 100 columns → `{cells 23, rung 2}`, `W 23`; an implementation that
    adopts the equal ancestor unconditionally (no C53 record) returns
    `{cells 35, rung 1}` and fails.
  - ambiguity falls through: rows 35 in a 30-cell slot box (`layoutCells`
    `undefined`) with the T15 probe `{side, visible, opened, loaded, 280}` →
    `{cells 35, rung 3}`, `W 35`, row
    `" 1.explore    Go/Kimi K3.1 P… "` (T15's string).
  - discriminator: `{layoutCells 40}` together with resolution 1600 px and 200
    columns and `cssWidth 280` → `{cells 40, rung 1}`. An implementation that
    asks rung 2 first returns `cells 35` and fails.
- **T25 — rung 2 versus rung 3, and which rung reads the option (C52, C46,
  C37).** declared 50, `cssWidth 360`:
  - resolution 1600 px, terminal 100 columns → `runtimeCellPx = 16`,
    `360 / 16 = 22.5 → 23` (half-up tie) → `{cells 23, rung 2}`, `W 23`.
  - resolution `null` → `runtimeCellPx undefined`, rung 3 with the option 8 →
    `360 / 8 = 45` → `{cells 45, rung 3}`, `W 45`.
  - option `cellPx: 10` **with** the resolution present → still
    `{cells 23, rung 2}`: rung 2 never reads the option. The same input with
    resolution `null` → `360 / 10 = 36` → `{cells 36, rung 3}`, which is how the
    fixture proves which rung owns the option.
  - terminal 100 columns but `rendererColumns 0` → rung 2 `undefined` → rung 3
    → `{cells 45, rung 3}`; a rung-2 implementation that divides by 0 yields
    `Infinity`/`NaN` and fails the exact value.

## 7. Known gaps

Where the current code, read-only, disagrees with this design. Each gap is a
Coder task; findings and fixes reference these IDs. D1 is the one entry that is
not a gap: it registers a temporary diagnostic, with no contract number. Line
references were refreshed against the tree in the A.9 round; an entry marked
"closed in code" no longer disagrees with the code and is kept for
traceability, not as a task.

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
- **G10 (R5) — closed in code; references refreshed.** The
  old claims are gone from the code: the instance column has its own
  `INSTANCE_FIXED_CELLS` / `INSTANCE_MODEL_CELLS`, the role cap has
  `ROLE_MODEL_MAX_CELLS`, and the former bare literals (`1000`, `96`, `10`,
  `35`) are named. What remains is A.5's separator move, which partially
  reverses A.3's layout move: `ROLE_FIXED_CELLS` 18 → 19,
  `INSTANCE_FIXED_CELLS` 17 → 18, `INSTANCE_MODEL_CELLS` 13 → 12, and
  `ROLE_BAR_GAP_CELLS = 1` / `INSTANCE_BAR_GAP_CELLS = 1` reinstated as two
  separate constants (`src/lib/collect.ts:295`, `:313`, `:310`; `roleHead`
  `:454-462`, `instanceHead` `:465-470`). `head` keeps its `W − 5` length and
  now ends with the separator cell; the TUI appends the boxes flush
  (`src/tui.tsx:344-346`). `MIN_ROW_CELLS = 19` stays the floor (F1). The
  60 / 1000 in `elapsed` are time units, not field widths.
- **G11 (R2, R3, R5)** — `truncate` counts UTF-16 code units, not display
  cells; wide characters and surrogate pairs misalign the boxes. The design
  measures cells (§0).
- **G12 (R9)** — The picker clips `agent · model` together at 96; the design
  clips the model label at `PICKER_MODEL_CELLS` and the agent separately at
  `PICKER_AGENT_CELLS`, with independent budgets (C28, C29). The live filter
  (`src/tui.tsx:414-417`, the dialog `search` callback) matches the raw
  `RunningSubagent` records through `filterRows` — `agent`, full `model`,
  `title`, elapsed text, session ID — not the clipped display strings
  (design R9's filter bullet). Fixture: model `"m"` × 96 + `"XY"` (98 cells)
  displays as 95 `m` + `…` (96 cells, C24), yet typing `XY` still matches the
  row because `filterRows` sees the full 98-cell field.
- **G13 (R6) — closed in code; references refreshed.** Working role rows
  receive the busiest instance's
  metric. The wiring is
  unchanged in shape but carries a new metric: `panel()` passes the
  busiest **active** instance's `tps` to the role row, not a `pct`
  (`src/lib/collect.ts:699-705`). `pct` is gone from `PanelRow` and from
  `RunningSubagent` (`:107`).
- **G14 (R4) — withdrawn at review.** The fallback `time.updated`, then
  `time.created`, and no grace row when neither exists, is already implemented
  (`src/lib/collect.ts:583`). No discrepancy; the remaining open point is
  the Product wording in F8.
- **G15 (R7)** — Overflow skips a non-fitting section and continues with
  later sections, which can show a lower-priority role after a folded
  higher-priority one. The design stops the body at the first non-fitting
  section (F5).
- **G16 (R6, §2 availability) — closed in code; references refreshed.** Two
  triggers.
  The sync path exists (`syncSession` / `resyncMessages`, `src/tui.tsx:190-228`)
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
  review by inspection, not by a pure-layer fixture (R12). A.8 does not narrow
  the sync gate: a temporary builtin is a visible agent, so its session syncs
  and its bar fills like a member's (G20). A.11 leaves this gate untouched:
  width detection is render-only, reads no data layer, and triggers no sync
  (§1.4).
- **G17 (R6) — closed in code; references refreshed.** The speed computation
  exists: `speedTps` (`src/lib/collect.ts:193-223`) keeps only counted
  assistant messages (§R6 filter) and returns
  `1000 × Σ tokens.output / Σ (completed − streamed)` or `undefined`;
  `barFill` (`:501-507`) is the C19 formula; `barTone` (`:510-512`) is
  `filled > 0 ? "success" : "muted"`; `pushInstance` (`:672-691`) and the role
  aggregation (`:699-705`) pass `tps`. `contextLimit`, `contextPct`,
  `lastUsage`, `PERCENT`, `WARNING_MIN_PCT`, `ERROR_MIN_PCT`, `BAR_MIN_FILL`,
  `row.pct`, `RunningSubagent.pct` and `TPS_PER_BOX` are absent from the tree.
  Constants (A.6, values at A.7): `FILL_BANDS = [5, 20, 50, 70, 100]` (floors
  1–4 inclusive, floor 5 exclusive); `FILL_MIN_BOXES` / `FILL_MAX_BOXES` are
  the clamps (`:319`, `:322`), and `barFill` keeps the
  `(tps: number | undefined) => number` signature, so its call sites
  (`src/tui.tsx:173`, `src/lib/collect.ts:666`, `:686`) already pass `tps`
  and need no change of shape.
  Recompute triggers: any watched host event (already bumps the
  signal), `session.step.ended` and `session.message.content.updated` after
  their re-sync (G16), and the
  existing 1 s ticker (`src/tui.tsx:315-319`) while it runs — speed itself
  never reads `now`, so a tick without new message data is a no-op.
- **G18 (R6) — closed in code; references refreshed.** Box colour comes from
  `barColor`
  (`src/tui.tsx:240-243`), which maps `barTone(filled)` to success/muted, and
  `:345` passes `row.filled`. Required: colour from `barTone(row.filled)` alone —
  filled cells `theme.text.feedback.success.base`, empty cells
  `theme.text.muted`, no warning or error path. The row **text** keeps its
  existing state colours (idle muted, grace warning, agent colour), which is
  a separate field.
- **G19 (R6) — closed in code; references refreshed.** The box literals are
  `BAR_GLYPH_FILLED = "▓"` (U+2593) and
  `BAR_GLYPH_EMPTY = "░"` (U+2591), one constant each, in the pure layer
  (`src/lib/collect.ts:268`, `:271`), rendered by the TUI from those imports
  (`src/tui.tsx:345-346`); no `▮` (U+25AE) / `▯` (U+25AF) literal remains.
  Nothing else in the bar changes: `BAR_CELLS` stays 5, the
  arithmetic and colours are untouched (C30, C31, A.4).
- **G20 (R1, R2, R3, R4, R7, §2.1, A.8) — closed in code; references
  refreshed.** Member selection is the A.8 snapshot now:
  `panel()` reads `sources.members` and takes `total` from its roles
  (`src/lib/collect.ts:547`, `:740`); `memberSet` and `BUILTIN_AGENT_IDS` are
  exported (`:72`), the TUI takes one snapshot per location
  (`src/tui.tsx:105-116`, `:443-445`), and only a non-member visible builtin
  with an instance gets a section (`src/lib/collect.ts:552-561`).
  The obligations recorded here stand: idle rows and `total`
  come from `members.roles`; a busy section is admitted for a visible
  charter-mode builtin that is not a member; `working` stays the busy-active
  count. The
  member snapshot's `AgentInfo` values serve member rows; the live list serves
  temporary builtins and R8. `isVisibleChild` stays permissive (any visible
  agent), or a temporary builtin's messages never sync (G16). R5 arithmetic,
  R6 bars, glyphs, tones and every C1–C34 value are unchanged.
- **G21 (R2, A.9)** — Built-in role rows print the model label today: `roleHead`
  (`src/lib/collect.ts:454-462`) always fits `model` into the column, and every
  busy and idle section carries one (`:606`, `:639`). Required: pass
  `agent.id ∈ BUILTIN_AGENT_IDS` into `roleHead` and take the C34 slot branch
  (`padCells(clip(BUILTIN_TAG_TEXT, roleModelField), roleModelField)`; A.11
  later generalises the field to C50), export `BUILTIN_TAG_TEXT`
  (C33), and leave instance rows, `barFill`, `barTone`, `PanelRow`, and every
  existing width constant untouched. No TUI change: the tag rides in
  `row.head` (`src/tui.tsx:344`). Fixtures T1–T5 pin the exact strings.
- **G22 (R3, A.10)** — Instance rows always print a model label: `instanceHead`
  (`src/lib/collect.ts:484-488`) always fits and pads a label, and
  `pushInstance` (`:696-711`) passes `instanceLabel(...)` (`:770-776`), which
  always returns text. Required: `instanceLabel` takes the section's role
  baseline (the section's definition label, mapped to `UNKNOWN_MODEL` when
  absent) and returns `undefined` when the two resolved short labels are equal
  (C35); `instanceHead` takes `string | undefined` and fills the column with
  spaces when undefined (C36); `pushInstance` passes `section.model` and maps
  the empty string through the same `resolvedShort` helper, not through a
  second unknown constant. `PanelRow`, the TUI (`src/tui.tsx:344`), every width
  constant, and all C1–C34 values are unchanged. Fixtures T6–T14 pin the exact
  strings.
- **G23 (R5, A.11) — closed in code; references refreshed.** The A.11 path is
  implemented: the probe is read inside the guarded memo (`src/tui.tsx:290-322`),
  `cellPx` is read with the C37 default (`resolveCellPx`,
  `src/lib/collect.ts:487`), `rowWidth` and the selector live in
  `src/lib/collect.ts:501-537`, `panel()` takes the `dynamic` flag
  (`:707`) and `roleHead`/`instanceHead` take the C48/C49 splits
  (`:591-628`). The obligations recorded here stand as the shape of the A.12
  change: detection feeds `W` and `dynamic` into `panel()`, and the field
  arithmetic stays in the pure layer.
- **G24 (R5, A.12)** — The ladder is A.11's, not R5's current three rungs:
  detection has one path (sidebar pixels ÷ the `cellPx` option) and never reads
  the renderer, so the panel under-fills by the difference between the assumed
  8 px/cell and the terminal's real cell size. Required: add the pure
  `RuntimeMetrics` (`layoutCells`, `boxCells`, `rowsCells`, `resolutionWidth`,
  `rendererColumns`),
  `runtimeCellPx` (C52), the ladder selector (C46) and the C53 dampener;
  extend `rowWidth` with the optional metrics and the `lastAccepted` record,
  returning `accepted`; capture the full-mode
  `<text>` by `ref` and read `parent.width`/`node.width` per pass under the
  C51 rule, with one bump per new node instance (`if (node !== panelNode)`; the
  inner full-mode component clears `panelNode` in `onCleanup`); read
  `context.renderer.resolution?.width` and `context.renderer.width` in the same
  try; subscribe once to `context.renderer.on("resize", bump)` and release it
  with `onCleanup`. The `cellPx` option stays, read by rung 3 only. Untouched:
  the C38–C50 splits, every C1–C50 value, the A.8 snapshot, the A.9 tag, the
  A.10 comparison, `FILL_BANDS`, glyphs, tones, and G16's sync gate.
- **D1 debug option (temporary diagnostic, not in the contract).** The plugin
  accepts `debug: true` or `debug: "<path>"` and appends one JSONL record per
  recompute to `/tmp/opencode/subagent-model-debug.jsonl`; the string form
  overrides the path. It is opt-in: with `debug` absent or `debug: false`
  nothing is written and the dump path is never touched, so the off-path
  impact is zero. A write failure is swallowed because it is a diagnostic, not
  a panel feature, so it cannot reach the R11 toast guard or change a row, and
  `README.md` documents the option as temporary. Investigation closed: the
  observed data lives in the §6 sanity fixtures; the option ships for future
  diagnostics and is planned for removal once unused.

## 8. Findings for the Project Manager

Open points in `docs/Product.md` that this design resolves. None may be
settled by the Designer alone; the Project Manager takes them to the Analyst
(or the human) for the final wording. F3 and F14 are settled by Product
updates; F16 is settled (human decision A1); F17 is obsolete at A.3; F18–F22
are the new decisions A.3 forces; F23 is settled (human decision A.4); F24 is
settled (human decision A.5); F20 is obsolete at A.6 (human decision).
F25–F28 are the new points A.8 surfaces; F29–F30 are the new points A.10
surfaces; F31–F36 are A.11's points, settled by PM arbitration (F31 by the
Product amendment to R2); F37 is A.12's ladder-units and rung-1-authority
reading, settled by PM arbitration; F38 is the post-ship host-module fact. F16, F17, F20, F23 and
F24 are listed with their source rather than as requests for an answer.

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
  already implements this fallback (`src/lib/collect.ts:583`); only the
  Product wording is open. Confirm.
- **F9 (R1 compact and R9 picker scope).** Neither requirement states a tab
  scope for the compact count or the picker. The design scopes the compact
  count like the panel (viewed tab) and makes the picker global (all running
  subagents). Confirm.
- **F10 (R10 toggle visibility) — settled by the Product update.** R10 now
  reads "disabled (but still shown in the palette) when the config forces
  `compact`" (`docs/Product.md` R10). The design gates the toggle with
  `enabled = (configured compact is not a boolean)` instead of unregistering
  it, so a config that forces the mode — including `compact: false`, which
  pins full mode — leaves the palette entry visible-but-disabled. Design and
  Product agree; no answer needed.
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
- **F20 (R6 rounding) — obsolete at A.6; band values moved at A.7.** Human
  decision A.6 replaces the half-up rounding with bands, so no fill step rounds
  at all: `filled` counts the `FILL_BANDS` floors the speed reaches (C18, C19),
  and `tps` itself is never rounded (C20). `TPS_PER_BOX = 20` (A.3) is
  superseded and deleted. The half-up fixtures `19 → 1`, `29 → 1`, `30 → 2`,
  `50 → 3`, `89 → 4`, `90 → 5` and the `9 → 0` does-not-fit value are retired
  with the formula; the boundaries now sit at `5 / 20 / 50 / 70 / 100`, each
  with its one-hair-below value pinned in C19, and the top boundary is
  exclusive (A.7): `100 → 4`, `100.01 → 5`. No answer needed; recorded so the
  code change is traceable.
- **F21 (R5 instance model text above width 35).** R5 gives the role model a
  width-dependent field (`width - 19, capped at 20`) but the instance model a
  fixed `12` plus "padding to align". The design reads that literally: the
  instance text cap stays 12 at every width and the extra column cells are
  padding (C13, C14, C27). A.11 changes the field size around that cap, never
  the cap. Confirm, or say the instance text grows with the field like the
  role's.
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
- **F25 (R2 snapshot boundary, A.8).** R2 says the mode is decided "at session
  start (or plugin activation)". The design takes the snapshot on the first
  render for a location and reuses it for the life of the plugin instance; the
  next snapshot for that location is the next plugin activation, not a new
  conversation in the same TUI process. A brand-new location takes its own
  first snapshot, and a missing first read delays it, never re-decides it.
  Confirm this boundary (S12).
- **F26 (R2 builtin identity, A.8).** The host `AgentInfo` has no origin field,
  so the design distinguishes charter definitions from built-ins by
  `BUILTIN_AGENT_IDS` (C32), the host v2.2.6 registry. Consequences: a custom
  agent defined only in `opencode.json` (not `.opencode/agents`) also selects
  charter mode, and a project file that overrides a builtin id stays
  builtin-classified. Confirm the set and the "definition" proxy, or name the
  host field that carries origin.
- **F27 (R1 charter with no visible definition, A.8).** A charter mode can have
  `M = 0` (the only definitions are hidden or primary). The design keeps R1's
  `total > 0` visibility rule, so the panel hides and no temporary builtin row
  can render (the computed title would be `0/0`). Confirm, or say the panel
  must show a running temporary builtin even when `M = 0`.
- **F28 (R2 exception vs R3 tab scope, A.8).** R2 says a builtin gets its
  temporary row while "at least one child session is in flight"; R3 scopes
  every instance row to the viewed tab. The design inherits R3's scope: only
  an in-scope instance materialises the temporary row, so a builtin working
  solely in another tab has no row here (and no idle builtin row). Confirm, or
  say the temporary row must appear for an out-of-scope session with no
  visible instance line.
- **F29 (R3, A.10 unknown vs unknown) — settled by PM arbitration.** R3 says
  the model label renders "when the instance's resolved model differs from the
  role's own resolved model, or when the instance's model is unknown", then
  says "When the labels agree, the model cell is omitted." When both sides
  resolve to no model, both clauses fire. The settled reading is the omit
  branch (C35, T9): both sides map through one helper to `UNKNOWN_MODEL`, they
  compare equal, the model cell adds no distinguishing fact, and the role
  row's column is blank too. If Product later prefers "always render an
  unknown instance model", C35 plus T9 move in the same commit. Recorded as a
  settled decision, not an open question.
- **F30 (R3, A.10 variant-only difference) — settled by PM arbitration.** The
  comparison operands are short labels, and the short label drops the variant
  (R8). Two refs that differ only by variant therefore compare equal and the
  cell is omitted (T14); a rendered label would show identical text, adding no
  information. A variant marker in the short label is not adopted, because it
  would move R8's label rule and the field's 12-cell budget. Recorded as a
  settled decision, not an open question.
- **F31 (R2 vs R5/A.11, name width) — settled by the Product amendment (PM
  arbitration).** R2 now reads: on the dynamic path the name uses the full
  proportional name field and clips with `…` only beyond that field; on the
  fallback path 9 cells as before. The design follows it: the name budget is
  `N` (C48, §1.1, §1.3) with no 9-cell cap, and `ROLE_NAME_CELLS = 9` plus
  C5's clips apply to the fallback path only. Fixture T23 and C5's dynamic
  twin.
- **F32 (R5, one width, two rows) — settled (no behaviour change).** The
  fallback/cap rule means a detected width of 35 and a configured width of 35
  produce different role rows
  (`" 1.explore    Go/Kimi K3.1 P… "` against
  `" 1.explore   Go/Kimi K3.1 Pro "`). That follows from "proportional once
  detection succeeds"; it also means a row can change once when the stored
  width loads. The fixture contract now makes the path explicit on every
  fixture and treats a same-`W` pair with different exact strings as expected
  (§6, A.11 fixture contract).
- **F33 (R5, floor under detection) — settled.** A sidebar narrower than 19
  cells still renders a 19-cell row that overflows the region: the detected
  width passes through the same `effectiveWidth(W) = max(MIN_ROW_CELLS, W)`
  the configured width already uses (§1.4), so F1's precedent holds.
- **F34 (R5, prompt.footer) — settled.** `usePanel()` throws outside a panel
  render, so detection applies only to the side region; `prompt.footer` and
  every non-side placement fall back to the configured width (§1.4).
- **F35 (R5, `sidebar.width()` semantics) — settled as a calibration
  caveat.** The SDK calls `PanelFrame.sidebar.width()` "the inner sidebar
  preference every side panel shares" (CSS px). It measures the inner sidebar
  region, which may include frame chrome — padding, borders, the reserved
  region toggle — and the design treats it as the slot content width without
  subtracting padding (§1.4). No padding constant is added, and the calibration
  knob is **rung 3's `cellPx` only** — the pixel path on the fallback side of
  the ladder. Rungs 1 and 2 cannot be calibrated with it: rung 1 is a layout
  cell count with no pixel conversion, and rung 2's divisor is measured from
  the renderer (C52), never from the option.
- **F36 (R5, rounding tie rule) — settled: half-up.** Product says "rounded"
  and "40% rounded" without a tie rule. The design fixes half-up everywhere —
  the share (C40, C41) and the pixel division (C46), where a tie `x.5` rounds
  up: `260 px / 8 = 32.5 → 33`, `rest 25 × 2/5 = 10.0 → 10`.
- **F37 (R5, A.12 ladder units and rung-1 authority) — settled by PM
  arbitration.** Two readings, both confirmed. (1) **Rung 2 semantics:** the
  runtime cell width is the **divisor**; the row width's pixel source stays
  the host's sidebar px, i.e. rung 2 uses the same px source as rung 3 and
  takes only the divisor from the renderer instead of the 8-pixel assumption
  (C52, C46). R5's "device pixels ÷ renderer cell columns" names that divisor,
  and a px/cell ratio alone could not produce a row width. (2) **Rung 1
  equality:** `A.width === P.width` is never authority; it is the **stable
  box** (C53). An equal ancestor is honoured only when a rung-1 win in this
  activation already recorded that exact width (`lastAccepted === rowsCells`);
  then the pass keeps `W` and no rung-2 consult happens. Otherwise — no record,
  a stale record, a shrink, an unreadable box — the pass falls to rung 2 and
  the record clears. That combination preserves the anti-latch rationale (a
  fallback-path pass cannot invent a record) and removes the rung-1 ↔ rung-2
  two-cycle the pure fall-through rule allowed at the box-equals-rows boundary
  (C51, C53, T24). The C51 accept condition stays strict
  (`A.width > P.width`).
- **F38 (R5, host module constraint) — runtime fact, post-ship A.12.** The TUI
  loader rejects static `@opencode/plugin/gui` submodule imports (verbatim in
  §1.4), so the probe resolves the module dynamically at setup and caches
  `undefined` on failure; an absent probe is the existing unavailability path
  (rung 1 only, configured-width fallback, silent). Product's "measurement path
  unavailable in the host runtime" covers it; the three-rung ladder stands.

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
- **A.6 band amendment.** Fill is banded, not rounded: the ordered
  `FILL_BANDS` floors (C18) give `barFill(tps)` as the count of floors the
  speed reaches, clamped to `FILL_MIN_BOXES`–`FILL_MAX_BOXES` (C19).
  `TPS_PER_BOX = 20` and the half-up formula (A.3) are deleted; `tps` is
  never rounded and C20 is untouched. Moved with it: R6's restatement and
  bands bullet, C16–C19 and C21's one-box fixture (`tps 5`, was `tps 10`),
  the `filled = 3` glyph fixture, G17's formula and constants list, and F20
  (now obsolete at A.6). A.7 later moved the floors to
  `[5, 20, 50, 70, 100]` and made the top floor exclusive; the live values are
  stated only in A.7. No §1 column, no glyph, no width, and no §2 source row
  changed: `barFill(tps)` keeps its signature and its call sites
  (`src/tui.tsx:152`, `src/lib/collect.ts:607`, `:627`) already pass `tps`.
- **A.7 band amendment.** Human decision at the R6 requirement level: the top
  band becomes strict and the lower floors move. `FILL_BANDS =
  [5, 20, 50, 70, 100]` tokens/sec; floors 1–4 are inclusive (`tps >= floor`,
  boxes 1–4) and floor 5 is exclusive (`tps > 100`, box 5), so `tps = 100`
  exactly fills 4 boxes and `100.01` fills 5 (C18). The fill formula is
  `clamp(#{b ∈ FILL_BANDS[0..3] : tps >= b} + (tps > FILL_BANDS[4] ? 1 : 0),
  FILL_MIN_BOXES, FILL_MAX_BOXES)` (C19); only comparisons touch `tps`, so
  there is no rounding and no floating-point fudge at 100. Moved with it: R6's
  restatement and bands bullet, C17's upper fixture (`100 → 4`), C18 and C19
  (all five boundaries with fits / does-not-fit values), the C19 sanity point
  `14.04` (now 1), the §1 `filled = 3` glyph fixture (`tps` 50 up to below
  70), G17's formula and constants list, and F20's boundary list. No column,
  glyph, width, tone, separator, or §2 source row changed; `BAR_CELLS`,
  `FILL_MIN_BOXES` and `FILL_MAX_BOXES` are untouched.
- **A.8 member-selection amendment.** Human decision at the R1/R2/R3/R4 level:
  the panel's member set is a snapshot. `memberSet` (C32) selects charter mode
  when the host agent list holds any id outside `BUILTIN_AGENT_IDS`, else
  built-in mode; the TUI takes one snapshot per location on its first render
  and never recomputes it (§2.1).
  Charter mode lists the visible `.opencode/agents` definitions only; builtins
  lose their idle rows and appear only as temporary rows while an in-scope
  instance is active or in grace. `total` (`M`) is the member-role count and
  never moves with temporary rows; `working` (`N`) includes them, so `N` can
  exceed `M` (S4). **Superseded:** R2 previously listed "builtin agents plus project
  agent definitions" unconditionally, with no mode; §0's Role definition,
  §3's idle predicate, §4's idle list and `total`, and §6's fixtures all
  followed that unconditional set. The member filter is new, not a
  clarification. **Moved:** §0 (Role, Instance, View `mode`/`total`/
  `working`), R1, R2, R3, R4, R7, R9 (one clarifying sentence), §2 source
  rows and the new §2.1, §3, §4, §5 (one sentence), §6 (new C32 and S1–S12),
  §7 (new G20 and the G16 sentence), §8 (new F25–F28). **Unchanged:** R5 width
  numbers, R6 bar logic, `FILL_BANDS`, glyphs, tones, and every C1–C31 value.
  The R9 picker needs no change: it lists running subagent sessions only, so a
  running builtin already appears and nothing idle is listed; its reference to
  R3's running-child predicate stays true because that predicate is unchanged,
  only the role attribution is.
- **A.9 built-in tag amendment.** Human decision at the R2 level: a built-in
  role row shows no model label and carries `[built-in]` instead, in charter
  mode (temporary rows) and built-in mode (permanent rows); instance rows of a
  built-in keep their model label and never carry the tag; a member row of a
  non-builtin agent is unchanged. **New numbers:** `BUILTIN_TAG_TEXT` = 10
  cells (C33) and the tag slot rule (C34: tag fills the existing role model
  column, `clip` to `W−19`, padded, so no width, instance column or member
  column moves). No other C value moved; `ROLE_MODEL_MAX_CELLS` is not applied
  to the tag. **Fixtures:** T1–T5 in §6 and the §1.1 width ladder examples
  (W 35 / 29 / 28 / 19), plus the member regression string
  `" 1.coder     Go/Kimi K3.1 Pro "` and the built-in instance twin
  `" ├ Inspect… Go/Grok 4.7       "`. **Precedence:** the name clip stays
  inside `ROLE_NAME_CELLS`, so a 10-cell name cannot eat the tag (T4).
  **Colour:** the tag is row text, so it takes the idle/active/warning row
  colour; `barTone`, `barFill` and the box colours are untouched (§3, R6).
  **Composition:** `roleHead` in the pure layer builds the tag row and the TUI
  renders `row.head` verbatim, so the exact tag-row fixtures are pinned
  through `panel()` in `src/lib/collect.test.ts`; this settles the earlier
  flag about title-string fixtures living outside the pure layer — role heads
  were already pure, and no TUI-side built-in head builder is added (§1.1).
  **Moved:** §0 (built-in role, `head`), R2, R5 (role field note), §1.1, §1.3,
  §2.1 (temporary-row bullet), §3 (tag colour), §5 (role row reads no model
  for a built-in), §6 (C33, C34, and the A.9 scenario subsection under
  `### A.9 built-in tag scenarios`), §7 (new G21). R8's resolution order is
  unchanged.
  **Same round, doc cleanup (no behaviour change):** every §7 line reference
  was refreshed against the current tree and each entry whose stated code fact
  the A.8 commit superseded is marked "closed in code" (G10, G13, G16, G17,
  G18, G19, G20; F8's reference too), with no obligation text changed; §2's
  `context.ui.router.current()` source row was removed because no reader
  exists — opening a picked session is `tabs.focus` /
  `router.navigate` (`src/tui.tsx:373-378`); and §R10 now describes the toggle
  as always registered with `enabled = options.compact === undefined`
  (`src/tui.tsx:513-518`), visible-but-disabled rather than unregistered. The
  Product R10 update ("disabled (but still shown in the palette)") settles the
  wording, so design and Product agree and F10 is closed with no open answer.
- **A.10 instance-model omission amendment.** Human decision at the R3 level:
  the instance model short label renders only when it differs from the role's
  own resolved model, or when the instance's model is unknown; labels are
  compared on the resolved short values **before** any clipping; when they
  agree the cell is omitted. **New numbers/rules:** C35 (visibility rule:
  `resolvedShort(instanceRef) !== resolvedShort(roleRef)`, one helper mapping
  an absent ref to `UNKNOWN_MODEL`) and C36 (omitted-slot rule: the same
  `W − 18` column holds spaces; title stays 8 cells, separator and boxes do
  not move). No width constant, no C1–C34 value, no glyph, no tone and no §1
  column changed; `INSTANCE_MODEL_CELLS = 12` still caps the text when shown.
  **Layout decision:** filler slot, not reflow, because reflow would widen the
  title past C11 or move the model field's start column and make the bar
  column depend on the title; the filler keeps `head = W − 5` with the
  separator at `W − 5`, so R5's last-5-columns invariant holds on mixed rows
  (T12). **Comparison operands:** instance side is R8 unchanged; role side is
  the section definition's `agent.model` (snapshot member, live temporary
  entry) mapped to the short label, `UNKNOWN_MODEL` when absent. A built-in
  role's `[built-in]` tag is never the operand; its definition model still is
  the baseline even though A.9 forbids printing it (C34/A.9 unchanged).
  Unknown vs unknown compares equal → omitted (F29, settled). Variant-only
  differences compare equal → omitted (F30, settled). **Churn:** the comparison runs on
  every `panel()` pass and is never cached, so a row can gain or lose the cell
  mid-session with no grace/timer/state effect; the role baseline for a member
  is the A.8 snapshot (stable) while instance resolution reads the live list
  (R8 step 2), so a post-snapshot definition change can move the instance side
  only. **Colour:** unchanged (row text rule, `barTone` untouched).
  **Composition:** `instanceLabel` in `src/lib/collect.ts` gains the role
  baseline and returns `string | undefined`; `instanceHead` blanks the column
  for `undefined`; the TUI keeps rendering `row.head` verbatim, so T6–T14 are
  pinned through `panel()` in `src/lib/collect.test.ts`. **Moved:** §0 (new
  Role baseline term, `head`), R2 (one parenthesis), R3 (fields, comparison
  operands, recompute, cap), R5 (instance field), §1.2 (table, formula,
  examples), §1.3 (comparison precedes clipping), §2 (source rows, new
  paragraph), §2.1 (member and temporary baselines), §3 (colour bullet), §5
  (A.10 paragraph), §6 (C35, C36, the A.10 scenario subsection T6–T14, and
  S4 reworded for the A.10 omission), §7
  (new G22), §8 (F29, F30). **Doc consistency fix in the same round (A.9
  review finding, no behaviour change):** the single-instance rows in T2 and
  C34 quoted `├`; C10 requires `└` on the last instance, so both now read
  `└` (`" └ Audit    Go/Grok 4.7       "`, `" └ Inspect… Go/Grok 4.7       "`).
  **A.10 round-1 review fixes:** the three split-rule fixtures (C35's differ
  case, T7's discriminator, T8's differing twin) now pin `Go/Kimi K3.…`, the
  value §1.3 computes at budget 12 with provider `Go`; §1.2's shown example
  reads 6 pad cells for an 11-cell label; T13 (the role text cap is not the
  comparison operand) and T14 (variant-only equality) were added; F29 and F30
  are recorded as settled by PM arbitration, not open questions.
- **A.11 dynamic-width amendment.** Human decision at the R5 level: the row
  width is derived at render time from the host's reactive
  `PanelFrame.sidebar.width()` (CSS px) divided by the new `cellPx` option
  (default 8) and rounded, and the field split is proportional. **Width
  rule:** detection available (panel in the side region, region visible,
  sidebar open, stored width loaded, finite positive CSS width) →
  `W = max(MIN_ROW_CELLS, min(configured, roundHalfUp(cssWidth / cellPx)))`, so
  the configured `width` is a cap; detection unavailable → the configured
  width governs. `MIN_ROW_CELLS = 19` is unchanged in both paths. **Split
  rule:** rest `W − 10` on both shapes; role name `roundHalfUp(rest × 2/5)`
  and model the remainder; instance title `min(roundHalfUp(rest × 2/5), 8)`
  with the unused title cells added to the model field; floors name/title 6
  and model field 4; a bound floor or missing detection selects the pre-A.11
  fixed arithmetic (9/`W−19` role, 8/`W−18` instance). **New numbers:**
  C37–C50. **Fixtures:** the §1.4 ladder plus T15–T23; C1/C2 and the C5–C36
  row strings stay fallback-path fixtures with unchanged values.
  **Unchanged:** `FILL_BANDS` and the whole R6 bar (A.7), A.8's member
  selection and snapshot, A.9's tag text and C33, A.10's comparison and C35,
  glyphs, tones, R9's picker budgets, R10's commands, and G16's sync gate.
  C34 and C36 now reference the derived field size `F` instead of the literal
  `W−19`/`W−18`; on the fallback path their values are identical.
  **Correction recorded for the Coder:** the instance rest is `W − 10`
  (indent 3 + gap 1 + separator 1 + boxes 5), not `W − 18`; `W − 18` is the
  fallback instance model field. `panel()` gains `dynamic = false` as its last
  parameter, so existing call sites and fixtures keep the fallback path.
  **Moved:** R2 (name sentence), R3 (title and model-field sentences), R5
  (dynamic and proportional bullets, fallback labelling), §0 (`head` width),
  §1 (`W` definition), §1.1, §1.2, §1.3 (budgets), new §1.4, §2 (probe source
  row and detection paragraph), §3 (colour note), §5 (A.11 sentence, R9/R10
  note), §6 (C5, C11, C33, C34, C36 wording; C37–C50; the A.11 fixture
  contract; the `### A.11` scenarios), §7 (G23, G16 sentence), §8 (F31–F36).
- **A.11 arbitration round (PM; F31–F36).** F31 settled by the Product
  amendment: R2's name bullet now gives the dynamic path the **full**
  proportional field, clipping with `…` only beyond it, and 9 cells on the
  fallback path. Layout numbers do not move, because `N` was already the split
  field; only the name **text budget** changes to `clip(name, N)`
  unconditionally on that path. Moved with it: the R2 sentence, §1.1's name
  budget note and its new `"design-review"` example, §1.3's budget sentence,
  C5 (scope "fallback path only" plus its dynamic twin), T4's dynamic twin,
  and the new T23. `N`, `M`, `T`, every head length (`W − 5`) and every
  C37–C50 value are unchanged: at W 35 a clipped name now uses 10 cells
  instead of 9 and the head stays 30 cells because `M` is still 15.
  **F32** settled with no behaviour change: the fixture contract now states
  the path on every fixture and calls a same-`W` pair with two exact strings
  legitimate. **F33** settled: §1.4 states that the detected width passes
  through the same `effectiveWidth` floor. **F34** kept: detection is
  side-region only and `prompt.footer` uses the configured width. **F35**
  settled as a caveat: `sidebar.width()` may include frame chrome, no padding
  is subtracted, `cellPx` is the calibration knob. **F36** settled: half-up,
  with a tie `x.5` rounding up stated in §1.4 and C46.
- **A.12 calibrated-width amendment.** Human decision at the R5 level (A.11
  upgraded): the row width is measured by a three-rung ladder, in this order,
  instead of by one pixel division. **Rung 1** is the renderer's layout tree
  read in terminal cells (C51): the full-mode panel `<text>` is captured by
  `ref`, its immediate parent (the host's slot boundary box) supplies
  `parent.width`, and the read is authoritative when that width is finite,
  positive, not the renderer root, and **strictly wider** than the panel's own
  width. The read is per pass inside the guarded memo, and a
  throw is a silent fallback; the only stored value is the C53 record, a width
  the panel already adopted. **Rung 2** measures pixels-per-cell from
  `renderer.resolution.width / renderer.width` (C52) and divides the sidebar
  pixel width by it — the same px source as rung 3, only the divisor comes from
  the renderer instead of the 8-pixel assumption — so a tie rounds up like
  every other width step.
  **F37 settled (PM arbitration):** rung 2 keeps the sidebar px source, and
  rung 1 equality is **not** authority. It is the stable box (C53): an equal
  ancestor keeps the width a rung-1 win already recorded in this activation
  (`lastAccepted === rowsCells`), and otherwise — no record, stale record,
  shrink, unreadable box — the pass falls to rung 2 and the record clears. This
  keeps the anti-latch rationale (a fallback-path pass cannot invent a record)
  and makes anti-oscillation provable in both directions: the box read
  re-enters every pass and only a strict win writes the record, while shrink
  (`A < P`) clears it, so the rung-1 ↔ rung-2 cycle at the 40-versus-35
  boundary is gone by construction (pass 1 35→40, pass 2 keeps 40).
  **The record** is a single number in the TUI, per activation, never
  persisted, never a signal, assigned every pass from `rowWidth`'s `accepted`,
  and `accepted` is `undefined` on every non-rung-1 outcome (so it clears on
  unused). It is not the A.8 member snapshot and does not touch G16.
  **Detach settle (arbitration, option 1):** the ref compares **node
  identity** — SDK refs fire on mount only (`@opentui/solid/index.js:430`,
  `:884`; `_removeNode` `:557` never calls back), so a different node object is
  a new full-mode mount and bumps once — and the inner full-mode component
  clears the pointer in `onCleanup`, so compact swaps and sidebar closes leave
  no detached-node read.
  **Rung 3** keeps A.11's `sidebar px / CELL_PX` (C37) as the last resort.
  **The option:** `cellPx` survives as the rung-3 divisor — a manual brake and
  a test override; rung 2 never reads it, so a user-set value no longer moves
  a panel whose terminal reports its pixel size. **Arithmetic unchanged:**
  C38–C50, every split/share/floor, `MIN_ROW_CELLS = 19`, the `width` cap,
  `FILL_BANDS`, `barFill`/`barTone`, the glyphs, the A.8 snapshot, the A.9 tag,
  the A.10 comparison, and G16's sync gate. **Fixtures:** C46 is rewritten as
  the selector and gains cross-rung discriminators; C47 keeps its formula with
  the rung and record passed through; C51, C52 and C53 are new and pinned with
  injected readings on both sides; T24 pins rung 1 through `rowWidth`, pins the
  dampener as two consecutive passes with the same result, pins the stale
  record falling and the shrink clearing it, and T25 pins rung 2
  against rung 3 and pins that the option belongs to rung 3. Every A.11
  fixture (T15–T23) passes no `RuntimeMetrics` and keeps its exact value at
  rung 3, so no existing string moved. **Invalidation:** one
  `renderer.on("resize", bump)` per activation, released on the activation's
  dispose path, plus
  the existing reactive `sidebar.width()` read; no polling, no width cache, no
  signal holding a width. **Why:** the observed 2-cell under-fill is the gap
  between the assumed 8 px/cell and the terminal's real cell size; rung 1
  removes both the assumption and the conversion, and rung 2 keeps a measured
  divisor where the layout tree is ambiguous. **Moved:** R5 (dynamic-width
  bullet), §0 (`head` width note), §1 (`W` definition), §1.4 (rewritten:
  ladder, both SDK surfaces, C51 rule, C53 dampener, rung 2/3, pure selector,
  TUI read, invalidation, bootstrap, R11), §2 (renderer source row, frame row
  relabelled, detection paragraph), §5 (A.12 measurement sentence), §6 (intro,
  C37, C46, C47, C51, C52, C53, the A.12 fixture contract, `### A.12`
  scenarios), §7 (G23 closed in code, new G24), §8 (F35 wording, F37).
  **Post-ship (F38):** TUI loader forbids gui submodule imports; `usePanel` resolves dynamically at setup, probe degrades to rung-1-only.
