import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { PanelFrame } from "@opencode/plugin/gui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { parseColor, type RGBA, type TextRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  BAR_CELLS,
  BAR_GLYPH_EMPTY,
  BAR_GLYPH_FILLED,
  BODY_MAX_LINES,
  DEFAULT_WIDTH,
  GRACE_MS,
  GRACE_TICK_MS,
  UNKNOWN_MODEL,
  barFill,
  barTone,
  collect,
  debugDumpPath,
  elapsed,
  filterRows,
  isVisibleRole,
  memberSet,
  modelRef,
  panel,
  pickerTitle,
  resolveCellPx,
  rowWidth,
  speedTps,
  type AgentInfo,
  type MemberSet,
  type PanelRow,
  type RunningSubagent,
  type RuntimeMetrics,
  type Sources,
  type WidthProbe,
} from "./lib/collect"

/** One record per recompute, so the temporary dump stops after this many (D1, F40). */
const DEBUG_MAX_LINES = 2000

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
  /** CSS pixels per cell for width detection (C37). */
  cellPx: number
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
    cellPx: resolveCellPx(raw.cellPx),
    debug:
      raw.debug === true
        ? debugDumpPath(process.env.XDG_STATE_HOME, homedir())
        : typeof raw.debug === "string" && raw.debug.length > 0
          ? raw.debug
          : undefined,
  }
}

/** Reads every data source once, against the location the TUI is showing. */
function sources(context: Context, members?: MemberSet): Sources {
  const location = context.location ?? context.data.location.default()
  return {
    sessions: context.data.session,
    agents: context.data.location.agent.list(location) ?? [],
    models: context.data.location.model.list(location) ?? [],
    providers: context.data.location.provider.list(location) ?? [],
    members,
  }
}

/**
 * A.8 snapshot: the mode and member roles are decided once per location, on the
 * first render whose agent list is loaded, and then read as data forever. A
 * later file change in `.opencode/agents` never moves the mode or `M` (F25).
 */
function memberSnapshot(context: Context, cache: Map<string, MemberSet>): MemberSet | undefined {
  const location = context.location ?? context.data.location.default()
  const cached = cache.get(location.directory)
  if (cached) return cached
  const list = context.data.location.agent.list(location)
  if (!Array.isArray(list)) return undefined
  // shortcut: a transient empty agent list would be cached as built-in mode for
  // the whole activation; upgrade when the host exposes a loaded hint.
  const snapshot = memberSet(list)
  cache.set(location.directory, snapshot)
  return snapshot
}

/** Sessions already asked of the host, so each one is synced once (G16). */
const syncedSessions = new Set<string>()

/** Per-session sync outcome for the temporary debug dump only. */
const syncState = new Map<string, "pending" | "ok" | "failed">()

/** True only when the diagnostic is on, so the off path writes no debug state. */
let debugEnabled = false

/** Records written this process, so the dump stops at `DEBUG_MAX_LINES` (D1, F40). */
let debugLines = 0

/** Last sync failure reported, so one broken host call toasts once. */
let lastSyncFailure: string | undefined

/**
 * Appends one JSON line to the debug log, creating its directory. A diagnostic
 * write never breaks the panel (R11). The explicit override keeps the same
 * 0700 directory / 0600 file modes as the default path, and an existing
 * directory or file keeps its mode: nothing here chmods.
 */
function debugLine(path: string, entry: unknown) {
  if (debugLines >= DEBUG_MAX_LINES) return
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    debugLines += 1
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

/**
 * Reads the source once for a panel pass and queues every in-scope instance's
 * message sync (G16). The full-mode view and the compact count share it, so the
 * gate and the diagnostic dump have one code path.
 */
function readInstances(
  context: Context,
  sessionID: string | undefined,
  bump: () => void,
  members?: MemberSet,
  debug?: string,
) {
  const data = sources(context, members)
  const rows = sessionID ? collect(data, sessionID) : []
  if (debug) debugDump(data, sessionID, debug)
  for (const row of rows) void syncSession(context, row.sessionID, bump)
  // F40: the guard set keeps only ids the host still lists, so a long-running
  // TUI does not accumulate dead sessions. Runs after the pass reads the list.
  for (const id of syncedSessions) {
    if (data.sessions.get(id) === undefined) {
      syncedSessions.delete(id)
      syncState.delete(id)
    }
  }
  // `total` is `panel()`'s member-role count, so compact shares the full gate.
  return { data, rows, total: data.members?.roles.length ?? 0 }
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

/**
 * Per-activation render state shared by the full-mode panel and the compact
 * line: the last good view (R11), the last running count (the compact
 * fallback), and the last reported failure (one toast per message).
 */
type GoodState = {
  view?: GoodView
  running?: number
  total?: number
  failure?: string
}

/**
 * Full-mode panel. It owns the layout handle for the C51 read: the ref fires on
 * mount only, so node identity — never absence — is the mount signal, and this
 * subtree's cleanup clears the handle when compact wins or the region goes.
 */
function FullPanel(props: {
  context: Context
  sessionID?: string
  tick: () => number
  bump: () => void
  width: () => number
  cellPx: () => number
  members: () => MemberSet | undefined
  debug?: string
  state: GoodState
  lastAccepted: () => number | undefined
  accept: (next?: number) => void
  frameOf?: () => PanelFrame
}) {
  const [beat, setBeat] = createSignal(0)

  // §1.4: a slot outside `Panel.render` throws here; detection then degrades to
  // the configured-width path instead of the R11 toast (F34). The cached
  // accessor is called per pass, never at setup: `usePanel()` needs a render.
  const resolveFrame = (): PanelFrame | undefined => {
    try {
      return props.frameOf?.()
    } catch {
      return undefined
    }
  }

  // §1.4: one layout handle, never a width value.
  let panelNode: TextRenderable | undefined
  // Refs fire on mount only (@opentui/solid/index.js:430, :884); the removal
  // path never calls back (_removeNode, :557). A different node is a new
  // full-mode mount and bumps once; a repeated call for the same node does
  // nothing.
  const attachPanel = (node: TextRenderable) => {
    if (node !== panelNode) {
      panelNode = node
      props.bump()
    }
  }
  // Compact swap, sidebar close, or region teardown unmounts this subtree:
  // clear the handle so no pass reads a detached node (§7 G24).
  onCleanup(() => {
    panelNode = undefined
  })

  // Source reads and view building share one guard: a thrown error keeps the
  // last good view, reports once per message, and never blanks the slot (R11).
  const guarded = createMemo(() => {
    props.tick()
    beat()
    try {
      // §1.4: the accessors are read inside this memo, so `sidebar.width()` is
      // tracked and a resize re-runs the pass. The value is never snapshotted.
      const frame = resolveFrame()
      const probe: WidthProbe | undefined = (() => {
        if (!frame) return undefined
        try {
          return {
            placement: frame.placement(),
            visible: frame.visible(),
            opened: frame.sidebar.opened(),
            loaded: frame.sidebar.transition(),
            cssWidth: frame.sidebar.width(),
          }
        } catch {
          // A detection failure is a layout fallback, never a panel failure.
          return undefined
        }
      })()
      // §1.4: one read of `A.width` per pass, projected twice (C51 truth,
      // C53 equality); `rowsCells` is the node's own separate getter read.
      const metrics: RuntimeMetrics | undefined = (() => {
        try {
          const renderer = props.context.renderer
          const parent = panelNode?.parent ?? undefined
          const boxCells =
            panelNode &&
            parent &&
            parent !== renderer.root &&
            Number.isFinite(parent.width) &&
            parent.width > 0
              ? parent.width
              : undefined
          return {
            layoutCells:
              panelNode && boxCells !== undefined && boxCells > panelNode.width
                ? boxCells
                : undefined,
            boxCells,
            rowsCells: panelNode?.width,
            resolutionWidth: renderer.resolution?.width,
            rendererColumns: renderer.width,
          }
        } catch {
          // A width failure is a fallback, never a toast.
          return undefined
        }
      })()
      const { W, dynamic, accepted } = rowWidth(
        props.width(),
        props.cellPx(),
        probe,
        metrics,
        props.lastAccepted(),
      )
      props.accept(accepted)
      const { data, rows: runningRows } = readInstances(
        props.context,
        props.sessionID,
        props.bump,
        props.members(),
        props.debug,
      )
      const view = panel(
        data,
        props.sessionID,
        W,
        BODY_MAX_LINES,
        Date.now(),
        GRACE_MS,
        dynamic,
      )
      // Compact counts running subagents; the title counts roles with a working
      // instance. Two fields, two derivations, never one shared value (R1).
      props.state.running = runningRows.length
      props.state.total = view.total
      props.state.failure = undefined
      props.state.view = view
      return view
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== props.state.failure) {
        props.state.failure = message
        props.context.ui.toast.show({ message })
      }
      return props.state.view
    }
  })

  const view = () => guarded()

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
          <text wrapMode="none" ref={attachPanel}>
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
      )}
    </Show>
  )
}

/**
 * Compact line: `sub N`, with the R11 fallback and the same per-activation
 * failure dedupe. Compact does no width arithmetic and captures no node.
 */
function CompactLine(props: {
  context: Context
  sessionID?: string
  tick: () => number
  bump: () => void
  members: () => MemberSet | undefined
  debug?: string
  state: GoodState
}) {
  const current = createMemo(() => {
    props.tick()
    try {
      const { rows, total } = readInstances(
        props.context,
        props.sessionID,
        props.bump,
        props.members(),
        props.debug,
      )
      props.state.running = rows.length
      props.state.total = total
      props.state.failure = undefined
      return { running: rows.length, total }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== props.state.failure) {
        props.state.failure = message
        props.context.ui.toast.show({ message })
      }
      if (props.state.running === undefined) return undefined
      return { running: props.state.running, total: props.state.total ?? 0 }
    }
  })

  const theme = props.context.theme

  return (
    <Show
      when={current()}
      fallback={<text fg={theme.text.muted}>subagent status unavailable</text>}
    >
      {(result) => (
        <Show when={result().total > 0}>
          <text fg={theme.text.feedback.success.base}>{`sub ${result().running}`}</text>
        </Show>
      )}
    </Show>
  )
}

function Status(props: {
  context: Context
  sessionID?: string
  tick: () => number
  bump: () => void
  compact: () => boolean
  width: () => number
  cellPx: () => number
  members: () => MemberSet | undefined
  debug?: string
  frameOf?: () => PanelFrame
}) {
  // §1.4 / C53: one adopted-width record per activation, held here so a compact
  // swap (FullPanel unmount) does not reset the dampener.
  let lastAccepted: number | undefined
  // R11 state is per activation too, so a compact/full swap keeps the last good
  // result and the deduplicated failure.
  const state: GoodState = {}

  return (
    <Show
      when={!props.compact()}
      fallback={
        <CompactLine
          context={props.context}
          sessionID={props.sessionID}
          tick={props.tick}
          bump={props.bump}
          members={props.members}
          debug={props.debug}
          state={state}
        />
      }
    >
      <FullPanel
        context={props.context}
        sessionID={props.sessionID}
        tick={props.tick}
        bump={props.bump}
        width={props.width}
        cellPx={props.cellPx}
        members={props.members}
        debug={props.debug}
        state={state}
        lastAccepted={() => lastAccepted}
        accept={(next) => {
          lastAccepted = next
        }}
        frameOf={props.frameOf}
      />
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
    // R9: filter the raw records, never the clipped display strings, so a term
    // that only matches a clipped-away tail still finds its row.
    search: (value, options) => {
      const keep = new Set(filterRows(rows, value).map((row) => row.sessionID))
      return options.filter((option) => keep.has(option.value))
    },
  })

  if (choice) openSession(context, choice)
}

export default Plugin.define({
  id: "subagent-live-status-plugin.tui",
  async setup(context) {
    // §1.4 (F38): the TUI loader forbids static gui submodule imports — one
    // fails the whole plugin. Resolve the accessor per activation; any failure
    // (loader rejection, unshipped module, wrong shape) caches undefined and
    // the probe degrades silently to rung-1-only. Cache the function, not a
    // frame: `usePanel()` throws outside `Panel.render`.
    let frameOf: (() => PanelFrame) | undefined
    try {
      const gui = await import("@opencode/plugin/gui")
      frameOf = typeof gui.usePanel === "function" ? gui.usePanel : undefined
    } catch {
      frameOf = undefined
    }
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

    // A.8: one frozen member set per location directory, for this activation.
    const memberSnapshots = new Map<string, MemberSet>()
    const members = () => memberSnapshot(context, memberSnapshots)

    const [tick, setTick] = createSignal(0)
    const bump = () => setTick((value) => value + 1)
    // §1.4: one layout invalidation per activation; getter reads do not
    // subscribe, so the renderer's resize event is the terminal trigger.
    context.renderer.on("resize", bump)
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
        cellPx={() => options.cellPx}
        members={members}
        debug={options.debug}
        frameOf={frameOf}
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
      context.renderer.off("resize", bump)
      for (const stop of [...stops, ...syncStops]) stop()
      removeSlot()
    }
  },
})
