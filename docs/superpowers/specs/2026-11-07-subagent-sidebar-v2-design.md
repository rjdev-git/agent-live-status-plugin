# Subagent sidebar v2: numbered rows with a context bar

## Intent

The current sidebar collapses every running subagent into one tally line
(`sub 3 · explore x2, general · Go/Kimi x2, Go/GPT`). With more than one
subagent the pairing between agent and model is lost, and nothing shows how
full each model's context window is.

v2 replaces the tally with one numbered row per subagent, each carrying a
five-box context indicator, so a nearly-compacting subagent is visible at a
glance.

## Goals

- One numbered row per running subagent, oldest first.
- Each row: `N. agent  Provider/Model  ■■■□□`.
- Context fill from the last assistant message, over the model's context limit.
- Width-safe: never wider than the configured cell budget.
- Keep `/subagents` picker, `compact` mode, and palette commands unchanged.

## Non-goals

- No cost, token, elapsed, or outcome columns in the sidebar.
- No auto-interrupt or auto-compaction.
- No sidebar width or height detection (not exposed by the host slot).
- No per-field configuration.

## Constraints

- `sidebar.content` slot input is `{ sessionID }` only: no width, no height.
  Layout must use a fixed budget, exposed as one `width` option (default 40).
- `SessionInfo.tokens` is cumulative and never falls after compaction; the
  live prompt size comes from `SessionInfo` messages. Fill is computed from
  the newest message that carries `tokens`:
  `(input + cache.read) / model.limit.context`.
- The sidebar caps at 20 rows. The number column is reserved for two digits, so
  `10.` aligns with ` 1.` and rows never reflow.
- `▮` U+25AE and `▯` U+25AF are assumed single-width. Fallback glyphs are
  `■`/`□` if a font disagrees.

## Layout budget (width 40)

| Part | Cells |
| --- | --- |
| `N.` (two-digit field) | 3 |
| agent name (clipped at 9) | 9 |
| space | 1 |
| `Provider/Model` (budget = width - 19, capped at 20) | 16 |
| gap | 1 |
| context boxes | 5 |

At the default `width: 35` the model label gets 16 cells. It widens with
`width` up to 20 cells, then stops. Past the budget it keeps one character less
and adds `…`.

`Provider` is the last word of the provider name (`OpenCode Go` → `Go`).
Variant is omitted in this layout. Model clips with `…`. Boxes never clip.

## Fill and colour

`filled = round(pct × 5 / 100)`, clamped to 0..5. Row text is green. Glyphs are
the narrow rectangles `▮` (filled) and `▯` (empty).

| Context | Boxes | Colour |
| --- | --- | --- |
| 0–49% | `▯▯▯▯▯` … `▮▮▯▯▯` | success |
| 50–69% | `▮▮▮▯▯` | warning |
| 70–100% | `▮▮▮▮▯`, `▮▮▮▮▮` | error |
| unknown | `▯▯▯▯▯` | muted |

## Overflow

Rows beyond the cap are counted, not listed:

```
Sub Agents
 1.explore   Go/Kimi K3.1 Pro ▮▮▮▯▯
…
20.review    Go/Grok 4.7      ▮▮▯▯▯
+3 more · /subagents
```

The muted `Sub Agents` title renders above the rows, only while at least one
subagent is running.

The overflow line is muted text; `/subagents` opens the existing picker.

## Behaviour

| Case | Render |
| --- | --- |
| 0 running | nothing (unchanged) |
| 1–20 running | numbered rows, no overflow line |
| 21+ running | first 20 rows plus `+N more` |
| `compact: true` | unchanged `sub N` line |

## Approaches considered

1. **Pure renderer, no data layer change** — rejected: the context percentage
   needs the model limit and per-message usage, neither of which the current
   `RunningSubagent` carries.
2. **Extend `RunningSubagent` with `modelShort` and `pct`, plus a pure
   `layout()` function** — chosen. Both stay unit-testable without the TUI
   SDK, and the component only colours what `layout()` returns.
3. **Render rows directly in the component** — rejected: untestable without a
   running OpenCode instance, and the width maths would live in JSX.

## Left to the builder

- Exact `theme` colour lookup for the box fill.
- Whether `layout()` sorts with `time.created` or keeps list order (chosen:
  sort by `since`, oldest first).
