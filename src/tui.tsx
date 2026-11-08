import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { parseColor, type RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  BAR_CELLS,
  BAR_GLYPH_EMPTY,
  BAR_GLYPH_FILLED,
  BODY_MAX_LINES,
  DEFAULT_WIDTH,
  GRACE_TICK_MS,
  UNKNOWN_MODEL,
  barFill,
  barTone,
  collect,
  elapsed,
  filterRows,
  isVisibleRole,
  modelRef,
  panel,
  matches,
  pickerTitle,
  speedTps,
  type AgentInfo,
  type PanelRow,
  type RunningSubagent,
  type Sources,
} from "./lib/collect"

/** Default path for the temporary debug dump; overridable with `debug: <path>`. */
const DEBUG_LOG_PATH = "/tmp/opencode/subagent-model-debug.jsonl"

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
  /** Debug log path when the diagnostic is on; undefined keeps it off. */
  debug?: string
}

type SlotInput = { sessionID?: string }

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
    debug:
      raw.debug === true
        ? DEBUG_LOG_PATH
        : typeof raw.debug === "string" && raw.debug.length > 0
          ? raw.debug
          : undefined,
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

/** Sessions already asked of the host, so each one is synced once (G16). */
const syncedSessions = new Set<string>()

/** Per-session sync outcome for the temporary debug dump only. */
const syncState = new Map<string, "pending" | "ok" | "failed">()

/** True only when the diagnostic is on, so the off path writes no debug state. */
let debugEnabled = false

/** Last sync failure reported, so one broken host call toasts once. */
let lastSyncFailure: string | undefined

/**
 * Appends one JSON line to the debug log, creating its directory. A diagnostic
 * write never breaks the panel (R11).
 */
function debugLine(path: string, entry: unknown) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  } catch {
    // Silent on purpose: the diagnostic must not surface as a plugin error.
  }
}

/**
 * Temporary diagnostic: the exact host shape behind the speed bar. One line per
 * recompute with every session in scope, its messages, and the derived speed.
 */
function debugDump(data: Sources, sessionID: string | undefined, path: string) {
  try {
    const scope = sessionID ? data.sessions.root(sessionID) : undefined
    const sessions = (data.sessions.list() ?? [])
      .filter(
        (session) =>
          session.parentID !== undefined &&
          scope !== undefined &&
          data.sessions.root(session.id) === scope,
      )
      .map((session) => {
        const messages = data.sessions.message?.list(session.id) ?? []
        const ref = modelRef(session, data)
        const tps = speedTps(messages)
        const newest = messages.slice(-6).map((entry) => {
          const message = entry as
            | { type?: unknown; tokens?: unknown; time?: unknown }
            | undefined
          return { type: message?.type, tokens: message?.tokens, time: message?.time }
        })
        return {
          sessionID: session.id,
          model: ref ? `${ref.providerID}/${ref.id}` : UNKNOWN_MODEL,
          messages: messages.length,
          newest,
          tps,
          filled: barFill(tps),
          sync: syncedSessions.has(session.id)
            ? (syncState.get(session.id) ?? "requested")
            : "not-requested",
        }
      })
    debugLine(path, { at: Date.now(), sessions })
  } catch {
    // Silent on purpose: a diagnostic failure must not become a panel failure.
  }
}

/**
 * Loads a session and its messages into the TUI data cache, then asks the panel
 * to recompute so the next pass reads the freshly landed cache. Best effort: a
 * sync failure is not a panel failure (R11, G16).
 */
async function syncSession(context: Context, sessionID: string, bump: () => void) {
  if (syncedSessions.has(sessionID)) return
  syncedSessions.add(sessionID)
  if (debugEnabled) syncState.set(sessionID, "pending")
  try {
    await context.data.session.sync(sessionID)
    bump()
    await context.data.session.message.sync(sessionID)
    bump()
    if (debugEnabled) syncState.set(sessionID, "ok")
    lastSyncFailure = undefined
  } catch (error) {
    if (debugEnabled) syncState.set(sessionID, "failed")
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastSyncFailure) {
      lastSyncFailure = message
      context.ui.toast.show({ message })
    }
  }
}

/**
 * Re-reads one instance's messages after a content update. The once-per-session
 * `syncedSessions` guard must not suppress this re-sync, so it takes its own
 * path: no session re-sync, no new timer (G16). Best effort like `syncSession`.
 */
async function resyncMessages(context: Context, sessionID: string, bump: () => void) {
  try {
    await context.data.session.message.sync(sessionID)
    bump()
    lastSyncFailure = undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastSyncFailure) {
      lastSyncFailure = message
      context.ui.toast.show({ message })
    }
  }
}

/** R3, §2: only a child session whose agent names a visible role is synced. */
function isVisibleChild(
  agents: AgentInfo[] | undefined,
  session: { parentID?: string; agent?: string } | undefined,
): boolean {
  if (!session?.parentID || !session.agent) return false
  const agent = agents?.find((entry) => entry.id === session.agent)
  return agent !== undefined && isVisibleRole(agent)
}

/** Box colour: the pure single-tone result mapped onto the theme (R6, C21). */
function barColor(theme: ResolvedTheme, filled: number) {
  return barTone(filled) === "success" ? theme.text.feedback.success.base : theme.text.muted
}

/** Row text colour: grey idle, warning in the failure grace, else agent colour. */
function rowColor(theme: ResolvedTheme, row: PanelRow): RGBA | string {
  if (row.state === "idle") return theme.text.muted
  if (row.state === "grace") return theme.text.feedback.warning.base
  if (row.agentColor) {
    // An unparseable colour is data, not a plugin error (R11).
    try {
      return parseColor(row.agentColor)
    } catch {
      return theme.text.feedback.success.base
    }
  }
  return theme.text.feedback.success.base
}

/** Inline coloured text inside a single `<text>` block. */
function Seg(props: { fg: RGBA | string; children: string }) {
  return <span style={{ fg: props.fg } as never}>{props.children}</span>
}

type GoodView = ReturnType<typeof panel>

function Status(props: {
  context: Context
  sessionID?: string
  tick: () => number
  bump: () => void
  compact: () => boolean
  width: () => number
  debug?: string
}) {
  const [beat, setBeat] = createSignal(0)
  let lastGood: { view: GoodView; running: number } | undefined
  let lastFailure: string | undefined

  // Source reads and view building share one guard: a thrown error keeps the
  // last good view, reports once per message, and never blanks the slot (R11).
  const guarded = createMemo(() => {
    props.tick()
    beat()
    try {
      const data = sources(props.context)
      const view = panel(data, props.sessionID, props.width(), BODY_MAX_LINES)
      // Every running instance in scope: queue its sync so the bar fills once it lands (G16).
      const runningRows = props.sessionID ? collect(data, props.sessionID) : []
      if (props.debug) debugDump(data, props.sessionID, props.debug)
      for (const row of runningRows) void syncSession(props.context, row.sessionID, props.bump)
      const running = runningRows.length
      lastFailure = undefined
      lastGood = { view, running }
      return lastGood
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastFailure) {
        lastFailure = message
        props.context.ui.toast.show({ message })
      }
      return lastGood
    }
  })

  const view = () => guarded()?.view
  const running = () => guarded()?.running ?? 0

  // A failed row expires on a clock, not on an event: tick once per second
  // for as long as any row sits inside the 30s grace window.
  createEffect(() => {
    if (!view()?.rows.some((row) => row.state === "grace")) return
    const timer = setInterval(() => setBeat((value) => value + 1), GRACE_TICK_MS)
    onCleanup(() => clearInterval(timer))
  })

  const theme = props.context.theme

  return (
    <Show
      when={view()}
      fallback={<text fg={theme.text.muted}>subagent status unavailable</text>}
    >
      {(current) => (
        <Show when={current().total > 0}>
          <Show
            when={!props.compact()}
            fallback={
              <text fg={theme.text.feedback.success.base}>{`sub ${running()}`}</text>
            }
          >
            <text wrapMode="none">
              <span style={{ fg: theme.text.base } as never}>
                {`Project Team Members ${current().working}/${current().total}`}
              </span>
              <For each={current().rows}>
                {(row) => (
                  <>
                    <br />
                    <Seg fg={rowColor(theme, row)}>{row.head}</Seg>
                    <Seg fg={barColor(theme, row.filled)}>{BAR_GLYPH_FILLED.repeat(row.filled)}</Seg>
                    <Seg fg={theme.text.muted}>{BAR_GLYPH_EMPTY.repeat(BAR_CELLS - row.filled)}</Seg>
                  </>
                )}
              </For>
              <Show when={current().more > 0}>
                <br />
                <span style={{ fg: theme.text.muted } as never}>{`+${current().more} more · /subagents`}</span>
              </Show>
            </text>
          </Show>
        </Show>
      )}
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

async function showDetails(context: Context, query?: string) {
  // The picker is global: all running child sessions, not scoped to one tab.
  const rows = filterRows(collect(sources(context)), query)
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
      title: pickerTitle(row.agent, row.model),
      value: row.sessionID,
      description: describe(row),
      footer: row.sessionID,
    })),
    actions: [
      {
        bind: "alt+o",
        title: "Open session",
        side: "right",
        // R9: alt+o opens without closing the picker, so no dialog clear here.
        onTrigger: (value) => {
          openSession(context, value)
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
  id: "subagent-live-status-plugin.tui",
  setup(context) {
    const options = readOptions(context)
    debugEnabled = options.debug !== undefined
    // Temporary diagnostic: the agent ids the host reports, dumped once.
    if (options.debug) {
      try {
        const agentIDs = (sources(context).agents ?? []).map((entry) => entry.id)
        debugLine(options.debug, { at: Date.now(), agents: agentIDs })
      } catch {
        // Silent on purpose: a diagnostic failure must not block setup.
      }
    }
    const [settings, updateSettings] = context.storage.store("subagent-live-status-plugin", {
      initial: { compact: false },
    })
    const compact = () => options.compact ?? settings.compact

    const [tick, setTick] = createSignal(0)
    const bump = () => setTick((value) => value + 1)
    const stops = WATCHED_EVENTS.map((type) => context.data.on(type, bump))
    // New child sessions and executions of a visible role load their usage so
    // the bars have data to read (G16, section 2). Root and unknown-agent
    // sessions never reach the data layer here.
    const syncStops = [
      context.data.on("session.created", (event) => {
        if (!isVisibleChild(sources(context).agents, event.data)) return
        void syncSession(context, event.data.sessionID, bump)
      }),
      context.data.on("session.execution.started", (event) => {
        const session = context.data.session.get(event.data.sessionID)
        if (!isVisibleChild(sources(context).agents, session)) return
        void syncSession(context, event.data.sessionID, bump)
      }),
      // A step ending finalises `tokens.output`, so the speed bar's data is
      // stale until the instance's messages are re-read. Same gate as above:
      // root and unknown-agent sessions never reach the data layer (G16).
      context.data.on("session.step.ended", (event) => {
        const session = context.data.session.get(event.data.sessionID)
        if (!isVisibleChild(sources(context).agents, session)) return
        void resyncMessages(context, event.data.sessionID, bump)
      }),
      // Belt-and-braces trigger: a new message must reach the cache before the
      // next panel pass; the once-per-session guard above is deliberately
      // bypassed (G16). The typed `on` map does not expose this host event, so
      // it arrives here; delivery is unverified, so `session.step.ended` above
      // is the trigger that is known to fire.
      context.data.listen((event) => {
        const details = event.details as { type: string; data?: { sessionID?: string } }
        if (details.type !== "session.message.content.updated") return
        const sessionID = details.data?.sessionID
        if (!sessionID) return
        const session = context.data.session.get(sessionID)
        if (!isVisibleChild(sources(context).agents, session)) return
        void resyncMessages(context, sessionID, bump)
      }),
    ]

    const removeSlot = claim(context, options.placement, (input) => (
      <Status
        context={context}
        sessionID={input.sessionID}
        tick={tick}
        bump={bump}
        compact={compact}
        width={() => options.width}
        debug={options.debug}
      />
    ))

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "subagent-live-status-plugin.show",
          title: "Show running subagent models",
          group: "Subagents",
          bind: options.bind,
          palette: true,
          slash: { name: "subagents", aliases: ["subagent-models"], arguments: true },
          enabled: () => true,
          run: (input) => showDetails(context, input),
        },
        {
          id: "subagent-live-status-plugin.toggleCompact",
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
      for (const stop of [...stops, ...syncStops]) stop()
      removeSlot()
    }
  },
})
