# subagent-live-status-plugin

[![License: MIT](https://img.shields.io/github/license/chatteridiot-git/subagent-live-status-plugin.svg?style=flat-square)](https://github.com/chatteridiot-git/subagent-live-status-plugin/blob/main/LICENSE)

Live model status for running subagents in the OpenCode TUI.

This plugin shows which model each active subagent is using, so you can quickly understand what is running without opening each session individually.

It is especially useful when you use different models for your main agent and subagents and want to confirm that each subagent is using the intended model from its configuration.

Current version: `1.3.0`

Project renamed to `subagent-live-status-plugin` (was `opencode-subagent-model`); plugin id, storage namespace, and command ids move with it — the persisted compact toggle resets once.

## Live preview

<img src="./opencode.png" alt="OpenCode plugin showing live subagent model status" width="70%" />

## Why use it

- The whole subagent team is visible all the time: working roles in colour, idle roles in grey
- Working instances nest under their role like subfolders, each with its own model and speed bar
- Browse all active subagents from one searchable picker
- Open any subagent session directly from the UI
- Keep the status compact when you want less visual noise

## Example output

A tree of agent roles. A role shows the agent definition; every running instance nests under it with its session title, model (only when it differs from the role's model), and speed bar:

```text
Project Team Members 1/5
 1.explore   [built-in]       ▓▓▓░░
 ├ Inspect… Go/Grok 4.7       ▓▓▓▓░
 └ Audit r…                   ▓░░░░
 2.reviewer                   ░░░░░
 3.qa                         ░░░░░
 4.writer                     ░░░░░
 5.research…                  ░░░░░
```

`explore` is a built-in agent working a task in a repo that also has `.opencode/agents` definitions: its role row shows the fixed `[built-in]` tag instead of a model. Its `Inspect…` instance runs a different model, so the model shows; its `Audit r…` instance uses the role's model, so the model cell is omitted. Charter-role rows (`reviewer` and friends) show their definition model instead of the tag.

States:

- Grey row = role waiting (idle), with empty muted boxes
- Coloured role = at least one instance of that agent is working; the colour comes from the agent definition (`color`), falling back to the theme's success green
- `├` / `└` rows = running instances, one per session, scoped to the tab you are viewing
- A failed or interrupted instance keeps its row in warning colour for 30 seconds, then folds back into its role row

The title counts roles currently working over roles known. The body caps at 10 lines; anything beyond folds into:

```text
+2 more · /subagents
```

Role rows are numbered (` 1.`, `20.` reserved), instance rows are unnumbered. Both row shapes fill exactly `width` cells, so the bars align vertically.

Row width is measured at runtime, from your terminal itself — no config needed. In priority order: (1) the renderer's own layout tree knows the sidebar container's width in cells (authoritative); (2) if that read is ambiguous, device pixels reported by the terminal are divided by the renderer's cell columns; (3) as a last resort, the host's reported sidebar pixel width divided by 8. The configured `width` stays as the cap and as the fallback when every measurement fails, floored at the same minimum as config mode. A live sidebar resize (or terminal resize) rebuilds the rows on the next render with no state side effects. On the detected path the row fields are proportional: the space after the number and before the separator+boxes (rest = width − 10) splits between the role name and the model — name gets 40% rounded up, model the remainder, floors of 6 and 4 cells; instance rows split title (capped at 8) and model the same way. Titles and names clip with `…` per the usual rules — without a fixed 12/20-cell cap on the detected path, so labels use the whole field that the split gives them. When an instance's model cell is omitted (its model equals the role's), the title absorbs the model cell's space instead: it clips only at the full width between the indent and the separator (rest + gap cells), on both paths, so long titles read whole where the old fillers wasted text space. Shown-model rows and role rows keep the layout described above. When detection is unavailable (`prompt.footer` placement, sidebar closed, terminal without a pixel report), the configured `width` governs with the fixed fallback field arithmetic.

The model label clips when the row is too tight: the provider keeps at most half of the budget, and the model name takes the rest. One separator cell sits between the model column and the boxes; the boxes are tight against each other. Boxes show throughput in bands: one box at 5–19.9 tokens/sec, two at 20–49.9, three at 50–69.9, four at 70–100, and five above 100 (strictly greater — 100.0 exactly stays in the four-box band); speeds below 5 fill none. Filled boxes are always green, empty boxes are muted, and an unknown speed is five muted empty boxes. A role-without-instance row always shows empty boxes.

**How to read the boxes.** The boxes show the subagent's measured output speed; each filled box is a step up in real speed, not a proportional fraction.

| boxes | model is producing |
| --- | --- |
| ▓ | 5–19.9 tokens/sec |
| ▓▓ | 20–49.9 |
| ▓▓▓ | 50–69.9 |
| ▓▓▓▓ | 70–100 |
| ▓▓▓▓▓ | above 100 (strictly) |
| ░░░░░ | below 5 (or speed still unknown) |

Compact mode keeps the old summary:

```text
sub 3
```

## Features

- Live team tree in the session UI (`sidebar.content` by default)
- Role rows with configured model, instance rows with live model and speed
- Built-in agents working in a repo with agent definitions get a temporary
  `[built-in]` role row (no model) while their session runs
- Instance model shows only when it differs from the role's model
- `/subagents` command and `/subagent-models` alias
- Palette command: `Show running subagent models`
- Palette command: `Toggle compact subagent status`
- Type-to-filter picker for agent, model, title, and elapsed time
- Direct open action for each subagent session

## How it works

Which agents the panel shows is decided once per session as a snapshot: with at least one agent definition in `.opencode/agents` (charter mode) it lists only those definitions (skipping agents marked `hidden` and primary agents), and built-in agents appear only as temporary rows while one of their sessions is running in this tab — a failed or interrupted one keeps its row for the 30-second grace window, then the row disappears with it. Without any `.opencode/agents` definition the panel falls back to listing the host's built-in agents, again skipping `hidden` and primary agents. Mid-session changes to `.opencode/agents` take effect on the next session, not the running one.

A session becomes an instance row when it is a child session currently marked `running`, and it belongs to the tab the viewer is in. A session that ended with `outcome: failed` or `interrupted` stays visible for a 30-second grace window before collapsing back into its role row.

The title counts how many roles have a working instance.

It resolves the instance model in this order:

1. the session model
2. the subagent's configured agent model
3. the nearest parent session model
4. `unknown model`

So an instance may resolve a model different from its role's `agent.md` — a per-session override wins. The panel shows the instance's model label only when it carries information: when the resolved model differs from the role's own resolved model, or when the instance's model is unknown. When the labels agree, the model cell is omitted and the row keeps its geometry. A built-in role row never shows a model — it shows the `[built-in]` tag — and its instances keep showing their model (when it carries information, per A.10).

The displayed label follows the format `ProviderName/ModelName`, and appends ` (variant)` when relevant. If a label is missing, the plugin falls back to the provider or model ID.

The sidebar rows use the short form: the provider's last word (`OpenCode Go` → `Go`) and no variant.

The speed bar is computed from the instance's own assistant messages: output tokens divided by the time they streamed, so it reports tokens per second. The five boxes fill in bands: 1 box at 5–19.9 tokens/sec, 2 at 20–49.9, 3 at 50–69.9, 4 at 70–100, 5 above 100 (strictly greater), none below 5. Cumulative session tokens are not used, and a message without both stream timings is skipped, so a session with no measurable message keeps five muted empty boxes instead of a guessed number. A role row's boxes mirror its busiest active instance.

The plugin syncs each running subagent session (session and messages) into the TUI data layer when the session appears on the panel or when its execution starts, then re-syncs the session's messages whenever one of its assistant steps ends (or a content update arrives), so the speed bar tracks tokens/sec live. A step end is the trigger the plugin relies on: it carries the final token count for the step. A sync failure surfaces as a host toast, and the affected row shows what is loaded.

## Commands

### `/subagents`

Opens a searchable list of running subagents.

It includes:

- agent name
- resolved model
- session title
- elapsed time
- session ID

The title line is `agent · model`, where the agent clips at 24 cells and the model at 96 cells, each independently cell-aware.

Type to filter the list. Press Enter to open the selected session, or use `alt+o` to open it without closing the picker.

Example:

```text
/subagents explore
```

### Palette commands

- `Show running subagent models`
- `Toggle compact subagent status`

## Configuration

Add the plugin in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "subagent-live-status-plugin",
      "options": {
        "placement": "sidebar.content",
        "bind": "ctrl+shift+s",
        "compact": false,
        "width": 35
      }
    }
  ]
}
```

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `placement` | `"sidebar.content"` \| `"sidebar.footer"` \| `"prompt.footer"` | `"sidebar.content"` | Where the live status is rendered |
| `bind` | `string` | unset | Keybind for the subagent picker |
| `compact` | `boolean` | unset | Forces compact mode (`sub N`) |
| `width` | `number` | `35` | Cell budget for a sidebar row; also the cap when width detection succeeds, and the fallback everywhere detection is unavailable |
| `cellPx` | `number` | `8` | Pixels-per-cell assumption for the LAST measurement rung only (when the terminal reports no pixel resolution); runtime measurement makes this moot on modern terminals |

The `debug` option ships as a diagnostic aid for future investigations:
`debug: true` enables it and appends a JSONL record per recompute to
`/tmp/opencode/subagent-model-debug.jsonl`; a string value overrides that
path. It is off unless enabled, is not part of the requirements contract, and
is planned for removal once it goes unused.

## Installation

The plugin is discovered from the OpenCode plugin directories.

Global config path:

```text
~/.config/opencode/plugins/subagent-live-status-plugin/
```

Project-local path:

```text
<project>/.opencode/plugins/subagent-live-status-plugin/
```

You can also symlink the plugin directory into place:

```sh
ln -s /path/to/subagent-live-status-plugin ~/.config/opencode/plugins/subagent-live-status-plugin
```

After installation, reload the TUI with `/reload` or restart OpenCode.

## Development

```sh
npm install
npm run typecheck
npm test
```

## Repository layout

```text
package.json             package metadata and exports
src/index.ts             plugin bootstrap entry
src/tui.tsx              TUI commands, slots, and dialogs
src/lib/collect.ts       model resolution, role tree, and layout logic
src/lib/collect.test.ts  unit tests for the data layer

```text
docs/superpowers/specs/  design documents
```

## License

MIT
