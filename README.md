# opencode-subagent-model

[![License: MIT](https://img.shields.io/github/license/chatteridiot-git/agent-live-status-plugin.svg?style=flat-square)](https://github.com/chatteridiot-git/agent-live-status-plugin/blob/main/LICENSE)

Live model status for running subagents in the OpenCode TUI.

This plugin shows which model each active subagent is using, so you can quickly understand what is running without opening each session individually.

It is especially useful when you use different models for your main agent and subagents and want to confirm that each subagent is using the intended model from its configuration.

## Live preview

<img src="./opencode.png" alt="OpenCode plugin showing live subagent model status" width="70%" />

## Why use it

- The whole subagent team is visible all the time: working roles in colour, idle roles in grey
- Working instances nest under their role like subfolders, each with its own model and context bar
- Browse all active subagents from one searchable picker
- Open any subagent session directly from the UI
- Keep the status compact when you want less visual noise

## Example output

A tree of agent roles. A role shows the agent definition; every running instance nests under it with its session title, model, and context bar:

```text
Project Team Members 1/5
 1.explore   Go/Kimi K3.1 Pro ▮▮▮▯▯
 ├ Inspect…  Go/Grok 4.7     ▮▮▮▮▯
 └ Audit r…  Go/MiniMax M3.… ▮▯▯▯▯
 2.reviewer                  ▯▯▯▯▯
 3.qa                        ▯▯▯▯▯
 4.writer                    ▯▯▯▯▯
 5.researcher                ▯▯▯▯▯
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

The model label clips when the row is too tight: the provider keeps at most half of the budget, and the model name takes the rest. Boxes show how full the model context window is: `filled = round(pct × 5 / 100)`. Bar boxes are green below 50%, yellow from 50%, red from 70%, independent of the row text colour. A role-without-instance row always shows empty boxes.

Compact mode keeps the old summary:

```text
sub 3
```

## Features

- Live team tree in the session UI (`sidebar.content` by default)
- Role rows with configured model, instance rows with live model and context
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

The context indicator reads the newest message that reports token usage and divides its prompt size (`input + cache read`) by the model's context limit. Cumulative session tokens are not used: they never fall after compaction, so the bar would never recover. A role row's box shows the fill of its busiest instance.

## Commands

### `/subagents`

Opens a searchable list of running subagents.

It includes:

- agent name
- resolved model
- session title
- elapsed time
- session ID

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
