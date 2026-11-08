# Sidebar v3: project team tree

Supersedes the v2 running-only sidebar. The panel becomes an always-visible
tree of subagent roles with live instance rows inside.

## Intent

Show who is on the team (every subagent-capable agent) and who is working, so
idle roles are visible the same way running ones are. Colour carries the
state; the tree carries the family.

## Rules

1. **Role row** — one per subagent agent (builtin + `.opencode/agents/*.md`,
   through `location.agent.list()`), excluding `hidden: true`. Idle until one
   of its instances runs.
2. **Instance row** — one per running session of that role, inside the
   current tab only. When the instance finishes, it collapses back into the
   role row, succeeded or not.
3. **Third state** — a failed or interrupted instance holds its row for a
   30-second grace window in warning colour, then collapses. Requires a
   1-second ticker while any row is inside the window.
4. **Colours** — idle: grey (`theme.text.muted`); active: the agent's own
   `color` from its definition, falling back to `theme.success`; failure
   grace: `theme.warning`, overriding `agent.color`.
5. **Title** — `Project Team Members N/M`, roles with instances over roles
   known. Always shown; the panel never hides now.
6. **Tree** — role rows carry the two-digit number (` 1.`). Instance rows
   are unnumbered, indented under the role with box-drawing glyphs `├` / `└`.
7. **Body cap** — 10 lines excluding the title. Order: green roles first
   (oldest instance first inside each), grouped with their instances, then
   grey roles alphabetically. Overflow folds into `+N more · /subagents`.
   An instance is never separated from its role row.

## Layout (width option, default 35, wrapMode none)

Role row (35 cells):

```
 1.explore   Go/Kimi K3.1 Pro ▮▮▮▯▯
```

3 number + 9 agent + 1 + 16 model (`fitModel`, provider capped at half) +
1 + 5 boxes. A role without a model in `agent.md` shows blank model cells.
While the role has instances, its box shows the fill of its busiest one.

Instance row (35 cells):

```
 ├ Inspect…  Go/Grok 4.7      ▮▮▮▮▯
```

3 (space + glyph) + 8 title (session title, clipped with `…`) + 1 + 17 model
field (`fitModel`, text capped at 12) + 1 + 5 boxes. The bar is the
instance's real context meter; role rows in idle state show empty muted
boxes. Boxes keep the v2 fill colours: green under 50, yellow 50–69, red
70+, independent of the row text colour. Role and instance bars sit in the
same columns.

## Sample

```
Project Team Members 2/5
 1.explore   Go/Kimi K3.1 Pro ▮▮▮▯▯
 ├ Inspect…  Go/Grok 4.7      ▮▮▮▮▯
 └ Audit r…  Go/MiniMax M3.1… ▮▯▯▯▯
 2.reviewer                  ▯▯▯▯▯
 3.qa                        ▯▯▯▯▯
 4.writer                    ▯▯▯▯▯
 5.researcher                ▯▯▯▯▯
```

Failed instance inside the grace window:

```
Project Team Members 1/5
 1.chat      Go/GPT-6 Luna    ▮▮▯▯▯
 ├ deplo… ✗  Go/Grok 4.7      ▮▯▯▯▯   (warning colour, 30s)
```

All idle:

```
Project Team Members 0/5
 1.chat                      ▯▯▯▯▯
 2.reviewer                  ▯▯▯▯▯
 …
+3 more · /subagents
```

## Non-goals

- No cross-tab instance visibility ("per tab" scope).
- No failure history after the grace window.
- No numbers on instance rows.
- Picker, compact mode, and palette commands unchanged.

## Left to the builder

- Exact tick implementation for the grace expiry (setInterval, started and
  stopped only when a grace row exists).
- Role ordering tiebreak when two roles start instances in the same render.
