# opencode-subagent-model

[![License: MIT](https://img.shields.io/github/license/chatteridiot-git/agent-live-status-plugin.svg?style=flat-square)](https://github.com/chatteridiot-git/agent-live-status-plugin/blob/main/LICENSE)

Live model status for running subagents in the OpenCode TUI.

This plugin shows which model each active subagent is using, so you can quickly understand what is running without opening each session individually.

It is especially useful when you use different models for your main agent and subagents and want to confirm that each subagent is using the intended model from its configuration.

## Live preview

<img src="./opencode.png" alt="OpenCode plugin showing live subagent model status" width="70%" />

## Why use it

- The whole subagent team is visible all the time: working roles in colour, idle roles in grey
- Working instances nest under their role like subfolders, each with its own model and speed bar
- Browse all active subagents from one searchable picker
- Open any subagent session directly from the UI
- Keep the status compact when you want less visual noise

## Example output

A tree of agent roles. A role shows the agent definition; every running instance nests under it with its session title, model, and speed bar:

```text
Project Team Members 1/5
 1.explore   Go/Kimi K3.1 Pro ▓▓▓░░
 ├ Inspect… Go/Grok 4.7       ▓▓▓▓░
 └ Audit r… Go/MiniMax …      ▓░░░░
 2.reviewer                   ░░░░░
 3.qa                         ░░░░░
 4.writer                     ░░░░░
 5.research…                  ░░░░░
```

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

The model label clips when the row is too tight: the provider keeps at most half of the budget, and the model name takes the rest. One separator cell sits between the model column and the boxes; the boxes are tight against each other. Boxes show throughput in bands: one box at 5 tokens/sec, two at 10, three at 20, four at 50, and five at 100 or more; speeds below 5 fill none. Filled boxes are always green, empty boxes are muted, and an unknown speed is five muted empty boxes. A role-without-instance row always shows empty boxes.

**How to read the boxes.** The boxes show the subagent's measured output speed; each filled box is a step up in real speed, not a proportional fraction.

| boxes | model is producing |
| --- | --- |
| ▓ | 5–10 tokens/sec |
| ▓▓ | 10–20 |
| ▓▓▓ | 20–50 |
| ▓▓▓▓ | 50–100 |
| ▓▓▓▓▓ | 100+ |
| ░░░░░ | below 5 (or speed still unknown) |

Compact mode keeps the old summary:

```text
sub 3
```

## Features

- Live team tree in the session UI (`sidebar.content` by default)
- Role rows with configured model, instance rows with live model and speed
- `/subagents` command and `/subagent-models` alias
- Palette command: `Show running subagent models`
- Palette command: `Toggle compact subagent status`
- Type-to-filter picker for agent, model, title, and elapsed time
- Direct open action for each subagent session

## How it works

The panel lists every subagent-capable agent the host knows: builtin agents and the ones from `.opencode/agents/*.md`, skipping agents marked `hidden` and primary agents.

A session becomes an instance row when it is a child session currently marked `running`, and it belongs to the tab the viewer is in. A session that ended with `outcome: failed` or `interrupted` stays visible for a 30-second grace window before collapsing back into its role row.

The title counts how many roles have a working instance.

It resolves the model in this order:

1. the session model
2. the subagent's configured agent model
3. the nearest parent session model
4. `unknown model`

So an instance may show a model different from its role's `agent.md` — a per-session override wins.

The displayed label follows the format `ProviderName/ModelName`, and appends ` (variant)` when relevant. If a label is missing, the plugin falls back to the provider or model ID.

The sidebar rows use the short form: the provider's last word (`OpenCode Go` → `Go`) and no variant.

The speed bar is computed from the instance's own assistant messages: output tokens divided by the time they streamed, so it reports tokens per second. The five boxes fill in bands: 1 box at 5 tokens/sec, 2 at 10, 3 at 20, 4 at 50, 5 at 100 or more, none below 5. Cumulative session tokens are not used, and a message without both stream timings is skipped, so a session with no measurable message keeps five muted empty boxes instead of a guessed number. A role row's boxes mirror its busiest active instance.

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
      "package": "opencode-subagent-model",
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
| `width` | `number` | `35` | Cell budget for a sidebar row; the model label clips to fit |

The `debug` option ships as a diagnostic aid for future investigations:
`debug: true` enables it and appends a JSONL record per recompute to
`/tmp/opencode/subagent-model-debug.jsonl`; a string value overrides that
path. It is off unless enabled, is not part of the requirements contract, and
is planned for removal once it goes unused.

## Installation

The plugin is discovered from the OpenCode plugin directories.

Global config path:

```text
~/.config/opencode/plugins/opencode-subagent-model/
```

Project-local path:

```text
<project>/.opencode/plugins/opencode-subagent-model/
```

You can also symlink the plugin directory into place:

```sh
ln -s /path/to/opencode-subagent-model ~/.config/opencode/plugins/opencode-subagent-model
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
