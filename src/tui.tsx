import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { parseColor, type RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  BAR_CELLS,
  GRACE_MS,
  collect,
  elapsed,
  filterRows,
  panel,
  matches,
  truncate,
  type PanelRow,
  type RunningSubagent,
  type Sources,
} from "./lib/collect"

const FILL = "▮"
const EMPTY = "▯"

const WATCHED_EVENTS = [
  "session.created",
  "session.deleted",
  "session.moved",
  "session.forked",
  "session.renamed",
  "session.status",
  "session.idle",
  "session.agent.selected",
  "session.model.selected",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

type Placement = "sidebar.content" | "sidebar.footer" | "prompt.footer"

type Options = {
  placement: Placement
  compact?: boolean
  bind?: string
  width: number
}

type SlotInput = { sessionID?: string }

const DEFAULT_WIDTH = 35

function readOptions(context: Context): Options {
  const raw = context.options ?? {}
  const placement: Placement =
    raw.placement === "sidebar.footer" || raw.placement === "prompt.footer"
      ? raw.placement
      : "sidebar.content"
  return {
    placement,
    compact: typeof raw.compact === "boolean" ? raw.compact : undefined,
    bind: typeof raw.bind === "string" ? raw.bind : undefined,
    width: typeof raw.width === "number" && raw.width > 0 ? raw.width : DEFAULT_WIDTH,
  }
}

/** Reads every data source once, against the location the TUI is showing. */
function sources(context: Context): Sources {
  const location = context.location ?? context.data.location.default()
  return {
    sessions: context.data.session,
    agents: context.data.location.agent.list(location) ?? [],
    models: context.data.location.model.list(location) ?? [],
    providers: context.data.location.provider.list(location) ?? [],
  }
}

/** Box colour: unknown muted, 70+ red, 50+ yellow, else green. */
function barColor(theme: ResolvedTheme, pct: number | undefined) {
  if (pct === undefined) return theme.text.muted
  if (pct >= 70) return theme.text.feedback.error.base
  if (pct >= 50) return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

/** Row text colour: grey idle, warning in the failure grace, else agent colour. */
function rowColor(theme: ResolvedTheme, row: PanelRow): RGBA | string {
  if (row.state === "idle") return theme.text.muted
  if (row.state === "grace") return theme.text.feedback.warning.base
  if (row.agentColor) return parseColor(row.agentColor)
  return theme.text.feedback.success.base
}

/** Inline coloured text inside a single `<text>` block. */
function Seg(props: { fg: RGBA | string; children: string }) {
  return <span style={{ fg: props.fg } as never}>{props.children}</span>
}

function Status(props: {
  context: Context
  sessionID?: string
  tick: () => number
  compact: () => boolean
  width: () => number
}) {
  const [beat, setBeat] = createSignal(0)

  const rows = createMemo(() => {
    props.tick()
    return collect(sources(props.context), props.sessionID)
  })

  const view = createMemo(() => {
    props.tick()
    beat()
    return panel(sources(props.context), props.sessionID, props.width(), 10)
  })

  // A failed row expires on a clock, not on an event: tick once per second
  // for as long as any row sits inside the 30s grace window.
  createEffect(() => {
    if (!view().rows.some((row) => row.state === "grace")) return
    const timer = setInterval(() => setBeat((value) => value + 1), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const theme = props.context.theme

  return (
    <Show when={view().total > 0}>
      <Show
        when={!props.compact()}
        fallback={
          <text fg={theme.text.feedback.success.base}>{`sub ${rows().length}`}</text>
        }
      >
        <text wrapMode="none">
          <span style={{ fg: theme.text.base } as never}>
            {`Project Team Members ${view().working}/${view().total}`}
          </span>
          <For each={view().rows}>
            {(row, index) => (
              <>
                <br />
                <Seg fg={rowColor(theme, row)}>{row.head}</Seg>
                <Seg fg={barColor(theme, row.pct)}>{FILL.repeat(row.filled)}</Seg>
                <Seg fg={theme.text.muted}>{EMPTY.repeat(BAR_CELLS - row.filled)}</Seg>
              </>
            )}
          </For>
          <Show when={view().more > 0}>
            <br />
            <span style={{ fg: theme.text.muted } as never}>{`+${view().more} more · /subagents`}</span>
          </Show>
        </text>
      </Show>
    </Show>
  )
}

function claim(context: Context, placement: Placement, render: (input: SlotInput) => JSX.Element) {
  switch (placement) {
    case "sidebar.footer":
      return context.ui.slot({ append: "sidebar.footer", render })
    case "prompt.footer":
      return context.ui.slot({ append: "prompt.footer", render })
    default:
      return context.ui.slot({ append: "sidebar.content", render })
  }
}

function openSession(context: Context, sessionID: string) {
  const session = context.data.session.get(sessionID)
  // Tabs only hold root sessions: focusing a child would focus its parent.
  if (!session?.parentID && context.ui.tabs.focus(sessionID)) return
  context.ui.router.navigate({ type: "session", sessionID })
}

function describe(row: RunningSubagent) {
  return [row.title, elapsed(row.since)].filter(Boolean).join(" · ")
}

async function showDetails(context: Context, sessionID: string | undefined, query?: string) {
  const rows = filterRows(collect(sources(context), sessionID), query)
  if (rows.length === 0) {
    await context.ui.dialog.alert({
      title: "Subagent models",
      message: query ? `No running subagent matches "${query}".` : "No subagent is running.",
    })
    return
  }

  const choice = await context.ui.dialog.select<string>({
    title: `Subagents (${rows.length})`,
    placeholder: "Filter by agent, model, or title",
    options: rows.map((row) => ({
      title: truncate(`${row.agent} · ${row.model}`, 96),
      value: row.sessionID,
      description: describe(row),
      footer: row.sessionID,
    })),
    actions: [
      {
        bind: "alt+o",
        title: "Open session",
        side: "right",
        onTrigger: (value) => {
          openSession(context, value)
          context.ui.dialog.clear()
        },
      },
    ],
    search: (value, options) =>
      options.filter((option) =>
        matches(value, option.title, option.description ?? "", option.footer ?? ""),
      ),
  })

  if (choice) openSession(context, choice)
}

export default Plugin.define({
  id: "opencode-subagent-model.tui",
  setup(context) {
    const options = readOptions(context)
    const [settings, updateSettings] = context.storage.store("opencode-subagent-model", {
      initial: { compact: false },
    })
    const compact = () => options.compact ?? settings.compact

    const [tick, setTick] = createSignal(0)
    const bump = () => setTick((value) => value + 1)
    const stops = WATCHED_EVENTS.map((type) => context.data.on(type, bump))

    const removeSlot = claim(context, options.placement, (input) => (
      <Status
        context={context}
        sessionID={input.sessionID}
        tick={tick}
        compact={compact}
        width={() => options.width}
      />
    ))

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-subagent-model.show",
          title: "Show running subagent models",
          group: "Subagents",
          bind: options.bind,
          palette: true,
          slash: { name: "subagents", aliases: ["subagent-models"], arguments: true },
          enabled: () => true,
          run: (input) => showDetails(context, currentSessionID(context), input),
        },
        {
          id: "opencode-subagent-model.toggleCompact",
          title: "Toggle compact subagent status",
          group: "Subagents",
          palette: true,
          enabled: options.compact === undefined,
          run: async () => {
            await updateSettings((draft) => {
              draft.compact = !draft.compact
            })
            context.ui.toast.show({
              message: settings.compact ? "Subagent status: compact" : "Subagent status: full",
            })
          },
        },
      ],
    }))

    return () => {
      for (const stop of stops) stop()
      removeSlot()
    }
  },
})

function currentSessionID(context: Context) {
  const current = context.ui.router.current()
  return current.type === "session" ? current.sessionID : undefined
}
