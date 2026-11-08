/**
 * Pure data layer for the subagent status plugin.
 *
 * Nothing here imports the TUI SDK: every function takes plain data, so it can
 * be unit tested without a running OpenCode instance.
 */

export type ModelRef = {
  id: string
  providerID: string
  variant?: string
}

export type ModelInfo = {
  id: string
  modelID: string
  providerID: string
  name: string
}

export type ProviderInfo = {
  id: string
  name: string
}

export type AgentInfo = {
  id: string
  name?: string
  model?: ModelRef
  /** "subagent" | "primary" | "all"; undefined behaves like subagent. */
  mode?: string
  hidden?: boolean
  /** Agent-definition colour token, used for the active row text. */
  color?: string
}

/** R2: one role per agent that is neither hidden nor primary. */
export function isVisibleRole(agent: AgentInfo): boolean {
  return !agent.hidden && agent.mode !== "primary"
}

/**
 * C32: the host builtin ids (host v2.2.6 registry). Membership classifies an
 * agent as builtin regardless of where its definition came from, so a project
 * file that overrides a builtin cannot make it a charter member (F26, A.8).
 */
export const BUILTIN_AGENT_IDS: ReadonlyArray<string> = [
  "build",
  "compaction",
  "explore",
  "general",
  "summary",
  "title",
]

/** A.8 member-selection mode: charter definitions or the host builtins. */
export type PanelMode = "charter" | "builtin"

/** A.8 snapshot: the mode and the member roles it selected. */
export type MemberSet = {
  mode: PanelMode
  /** Visible roles of the selected mode; this list is `M`. */
  roles: AgentInfo[]
}

/**
 * A.8: partitions the host list once per activation. `mode` looks at the
 * unfiltered custom list, so a hidden or primary custom definition still
 * selects charter mode while contributing no row. A builtin id is always
 * builtin-classified, even when a project file overrides it (C32, F26).
 */
export function memberSet(agents: AgentInfo[]): MemberSet {
  const custom = agents.filter((agent) => !BUILTIN_AGENT_IDS.includes(agent.id))
  const builtin = agents.filter((agent) => BUILTIN_AGENT_IDS.includes(agent.id))
  const mode: PanelMode = custom.length > 0 ? "charter" : "builtin"
  const roles = (mode === "charter" ? custom : builtin).filter(isVisibleRole)
  return { mode, roles }
}

export type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
  model?: ModelRef
  title?: string
  outcome?: "succeeded" | "failed" | "interrupted"
  time?: { created?: number; updated?: number; idle?: number }
}

export type SessionSource = {
  list(): SessionInfo[]
  get(sessionID: string): SessionInfo | undefined
  root(sessionID: string): string
  status(sessionID: string): "idle" | "running"
  message?: { list(sessionID: string): ReadonlyArray<unknown> }
}

export type Sources = {
  sessions: SessionSource
  agents?: AgentInfo[]
  models?: ModelInfo[]
  providers?: ProviderInfo[]
  /** A.8 snapshot. Absent means no members: `total = 0` and no rows. */
  members?: MemberSet
}

export type RunningSubagent = {
  sessionID: string
  agent: string
  model: string
  title: string
  since?: number
  /** Short `Provider/Model` label used by the sidebar rows. */
  modelShort?: string
}

export const UNKNOWN_MODEL = "unknown model"
export const UNKNOWN_AGENT = "subagent"

/**
 * Builds `ProviderName/ModelName (variant)`, falling back to raw IDs.
 * `short` uses the provider's last word and drops the variant.
 */
export function labeler(
  models: ModelInfo[] = [],
  providers: ProviderInfo[] = [],
  short = false,
) {
  const byModel = new Map<string, string>()
  for (const entry of models) {
    byModel.set(`${entry.providerID}:${entry.modelID}`, entry.name)
    byModel.set(`${entry.providerID}:${entry.id}`, entry.name)
  }
  const byProvider = new Map(providers.map((entry) => [entry.id, entry.name]))

  return (model: ModelRef) => {
    const name = byModel.get(`${model.providerID}:${model.id}`) ?? model.id
    const provider = byProvider.get(model.providerID) ?? model.providerID
    const shown = short ? (provider.split(/\s+/).filter(Boolean).at(-1) ?? provider) : provider
    const variant = !short && model.variant ? ` (${model.variant})` : ""
    return `${shown}/${name}${variant}`
  }
}

/**
 * Session model, else the subagent's configured model, else the nearest
 * ancestor session model.
 */
export function modelRef(session: SessionInfo, sources: Sources): ModelRef | undefined {
  if (session.model) return session.model

  if (session.agent) {
    const agent = sources.agents?.find((entry) => entry.id === session.agent)
    if (agent?.model) return agent.model
  }

  const seen = new Set([session.id])
  let parentID = session.parentID
  while (parentID && !seen.has(parentID)) {
    seen.add(parentID)
    const parent = sources.sessions.get(parentID)
    if (!parent) break
    if (parent.model) return parent.model
    parentID = parent.parentID
  }

  return undefined
}

export function resolveModel(
  session: SessionInfo,
  sources: Sources,
  label = labeler(sources.models, sources.providers),
): string {
  const ref = modelRef(session, sources)
  return ref ? label(ref) : UNKNOWN_MODEL
}

/** One assistant message's token report and stream window (R6, §2). */
type SpeedMessage = {
  type?: string
  tokens?: { output?: number }
  time?: { created?: number; streamed?: number; completed?: number }
}

/**
 * R6: output tokens per second over the instance's counted assistant messages.
 * A message counts only with a finite `tokens.output >= 0` and a measurable
 * stream window (`completed > streamed >= created`). Anything else is skipped
 * whole. Unknown (no counted message, `Σ ms <= 0`, or a non-finite sum) is
 * `undefined`, never a guessed zero.
 */
export function speedTps(messages: ReadonlyArray<unknown> = []): number | undefined {
  let tokens = 0
  let ms = 0
  for (const entry of messages) {
    const message = entry as SpeedMessage | undefined
    if (!message || message.type !== "assistant") continue
    const output = message.tokens?.output
    const created = message.time?.created
    const streamed = message.time?.streamed
    const completed = message.time?.completed
    if (
      typeof output !== "number" ||
      !Number.isFinite(output) ||
      output < 0 ||
      typeof created !== "number" ||
      !Number.isFinite(created) ||
      typeof streamed !== "number" ||
      !Number.isFinite(streamed) ||
      typeof completed !== "number" ||
      !Number.isFinite(completed) ||
      !(completed > streamed) ||
      !(streamed >= created)
    ) {
      continue
    }
    tokens += output
    ms += completed - streamed
  }
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || ms <= 0) return undefined
  return (1000 * tokens) / ms
}

/** Collapses newlines and repeated spaces so titles stay on one line. */
export function cleanTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** Running child sessions in the same family as `sessionID`. */
export function collect(sources: Sources, sessionID?: string): RunningSubagent[] {
  const label = labeler(sources.models, sources.providers)
  const shortLabel = labeler(sources.models, sources.providers, true)
  const scope = sessionID ? sources.sessions.root(sessionID) : undefined

  const roots = new Map<string, string>()
  const rootOf = (id: string) => {
    const cached = roots.get(id)
    if (cached !== undefined) return cached
    const value = sources.sessions.root(id)
    roots.set(id, value)
    return value
  }

  const rows: RunningSubagent[] = []
  for (const session of sources.sessions.list()) {
    if (!session.parentID) continue
    if (scope && rootOf(session.id) !== scope) continue
    if (sources.sessions.status(session.id) !== "running") continue
    const ref = modelRef(session, sources)
    rows.push({
      sessionID: session.id,
      agent: session.agent ?? UNKNOWN_AGENT,
      model: ref ? label(ref) : UNKNOWN_MODEL,
      modelShort: ref ? shortLabel(ref) : UNKNOWN_MODEL,
      title: cleanTitle(session.title ?? session.id),
      since: session.time?.created,
    })
  }

  return rows
}

/** Speed boxes on every row, filled or empty. */
export const BAR_CELLS = 5

/** Filled box glyph, one cell advance, flush against its neighbour (C30). */
export const BAR_GLYPH_FILLED = "▓"

/** Empty box glyph, one cell advance, flush against its neighbour (C31). */
export const BAR_GLYPH_EMPTY = "░"

/** Row width in cells when the width option is absent. */
export const DEFAULT_WIDTH = 35

/** Body lines: role and instance rows; the title and overflow line excluded. */
export const BODY_MAX_LINES = 10

/** Digits reserved for the role number, so ` 1.` and `20.` align. */
export const ROLE_NUMBER_DIGITS = 2

/** Role number field: two digits plus the dot. */
export const ROLE_NUMBER_CELLS = 3

/** Agent names are clipped to this many cells so the model column aligns. */
export const ROLE_NAME_CELLS = 9

/** Space between the agent name field and the model column. */
export const ROLE_NAME_GAP_CELLS = 1

/** Hard cap on the role model label text, so a wide sidebar does not stretch it. */
export const ROLE_MODEL_MAX_CELLS = 20

/** Every role row cell except the model column: number, name, gap, separator, boxes. */
export const ROLE_FIXED_CELLS = 19

/** One separator cell between the role model field and the first box glyph. */
export const ROLE_BAR_GAP_CELLS = 1

/** Instance indent: space, tree glyph, space. */
export const INSTANCE_INDENT_CELLS = 3

/** Instance titles are clipped to this many cells. */
export const INSTANCE_TITLE_CELLS = 8

/** Space between the instance title field and the model column. */
export const INSTANCE_TITLE_GAP_CELLS = 1

/** Instance model labels are clipped to this many cells. */
export const INSTANCE_MODEL_CELLS = 12

/** Every instance row cell except the model column: indent, title, gap, separator, boxes. */
export const INSTANCE_FIXED_CELLS = 18

/** One separator cell between the instance model field and the first box glyph. */
export const INSTANCE_BAR_GAP_CELLS = 1

/** Lower fill clamp: an unknown or negative speed fills no box. */
export const FILL_MIN_BOXES = 0

/** Upper fill clamp: the bar stops at the box count. */
export const FILL_MAX_BOXES = 5

/** Band floors in tokens/sec, ascending; a band's 1-based position is its box count. */
export const FILL_BANDS: ReadonlyArray<number> = [5, 20, 50, 70, 100]

/** Grace window for a failed or interrupted instance row, in milliseconds. */
export const GRACE_MS = 30_000

/** Period of the ticker that expires grace rows, in milliseconds. */
export const GRACE_TICK_MS = 1_000

/** Cell budget for the picker's model label. */
export const PICKER_MODEL_CELLS = 96

/** Cell budget for the picker's agent field. */
export const PICKER_AGENT_CELLS = 24

/** Cells reserved for the ellipsis at the end of a clipped label. */
export const ELLIPSIS_CELLS = 1

/** The provider may take at most this share of a split model field. */
export const PROVIDER_MAX_SHARE = 1 / 2

/** Below this a row cannot hold its fields, so the configured width is raised. */
const MIN_ROW_CELLS = 19

/** Zero-cell code points: combining marks attach to the preceding cell. */
const ZERO_CELL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
]

/** Two-cell code points: East Asian Wide and Fullwidth. */
const WIDE_CELL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

function inRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([low, high]) => code >= low && code <= high)
}

/** Display cells of one code point: 0 combining, 2 wide, else 1. */
function charCells(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (inRanges(code, ZERO_CELL_RANGES)) return 0
  if (inRanges(code, WIDE_CELL_RANGES)) return 2
  return 1
}

/** Terminal cells a string occupies. */
export function cellWidth(text: string): number {
  let cells = 0
  for (const char of text) cells += charCells(char)
  return cells
}

/** Clips `text` to `cells` display cells, reserving one for the ellipsis. */
export function clip(text: string, cells: number): string {
  if (cells <= 0) return ""
  if (cellWidth(text) <= cells) return text
  if (cells === 1) return "…"
  const budget = cells - ELLIPSIS_CELLS
  let shown = ""
  let used = 0
  for (const char of text) {
    const width = charCells(char)
    if (used + width > budget) break
    shown += char
    used += width
  }
  return `${shown}…`
}

/** Pads `text` with spaces to exactly `cells` display cells. */
function padCells(text: string, cells: number): string {
  const width = cellWidth(text)
  return width >= cells ? text : `${text}${" ".repeat(cells - width)}`
}

/**
 * Fits `Provider/Model` into `budget` cells. When it overflows, the provider
 * may take at most half; the rest goes to the model name, so a long provider
 * cannot eat the model.
 */
export function fitModel(label: string, budget: number): string {
  if (budget < 3) return clip(label, budget)
  if (cellWidth(label) <= budget) return label
  const slash = label.indexOf("/")
  if (slash < 0) return clip(label, budget)

  const provider = label.slice(0, slash)
  const model = label.slice(slash + 1)
  const providerCells = Math.floor(budget * PROVIDER_MAX_SHARE) - 1
  const shownProvider = clip(provider, providerCells)
  const modelCells = budget - cellWidth(shownProvider) - 1
  return `${shownProvider}/${clip(model, modelCells)}`
}

/** Picker title line: `agent · model`, each side clipped on its own budget (C28, C29). */
export function pickerTitle(agent: string, model: string): string {
  return `${clip(agent, PICKER_AGENT_CELLS)} · ${clip(model, PICKER_MODEL_CELLS)}`
}

function effectiveWidth(width: number): number {
  return Math.max(MIN_ROW_CELLS, width)
}

function roleColumn(width: number): number {
  return effectiveWidth(width) - ROLE_FIXED_CELLS
}

function instanceColumn(width: number): number {
  return effectiveWidth(width) - INSTANCE_FIXED_CELLS
}

/** Role row text: number, agent name, and the model column. */
function roleHead(index: number, name: string, model: string, width: number): string {
  const column = roleColumn(width)
  const number = String(index).padStart(ROLE_NUMBER_DIGITS)
  const agent = padCells(clip(name, ROLE_NAME_CELLS), ROLE_NAME_CELLS)
  const modelField = model
    ? padCells(fitModel(model, Math.min(column, ROLE_MODEL_MAX_CELLS)), column)
    : " ".repeat(column)
  return `${number}.${agent}${" ".repeat(ROLE_NAME_GAP_CELLS)}${modelField}${" ".repeat(ROLE_BAR_GAP_CELLS)}`
}

/** Instance row text: indent, title, and the model column. */
function instanceHead(glyph: "├" | "└", title: string, model: string, width: number): string {
  const column = instanceColumn(width)
  const shownTitle = padCells(clip(cleanTitle(title), INSTANCE_TITLE_CELLS), INSTANCE_TITLE_CELLS)
  const modelField = padCells(fitModel(model, Math.min(column, INSTANCE_MODEL_CELLS)), column)
  return ` ${glyph} ${shownTitle}${" ".repeat(INSTANCE_TITLE_GAP_CELLS)}${modelField}${" ".repeat(INSTANCE_BAR_GAP_CELLS)}`
}

export type RowState = "idle" | "active" | "grace"

export type PanelRow = {
  /**
   * The full text before the boxes: role number and name or instance glyph
   * and title, then the model field.
   */
  head: string
  /** Filled boxes, 0-`BAR_CELLS`. Empty for an idle or grace row. */
  filled: number
  /** Speed the fill was derived from. Unknown renders empty boxes. */
  tps?: number
  state: RowState
  /** Agent-definition colour, applied while a row is not idle. */
  agentColor?: string
}

type Section = {
  agentID: string
  name: string
  color?: string
  model: string
  instances: Array<{ session: SessionInfo; state: "active" | "grace" }>
}

/** Speed tone: filled boxes are success green, empty boxes are muted (C21). */
export type BarTone = "success" | "muted"

/** Boxes filled by `tps`: inclusive lower floors plus the exclusive top floor, clamped (C19). */
export function barFill(tps: number | undefined): number {
  if (tps === undefined || !Number.isFinite(tps)) return FILL_MIN_BOXES
  const top = FILL_BANDS[FILL_BANDS.length - 1]
  const reached = FILL_BANDS.slice(0, FILL_BANDS.length - 1).filter((band) => tps >= band).length
  const filled = reached + (tps > top ? 1 : 0)
  return Math.min(FILL_MAX_BOXES, Math.max(FILL_MIN_BOXES, filled))
}

/** Colour class derived from the fill alone, never from the row text colour. */
export function barTone(filled: number): BarTone {
  return filled > 0 ? "success" : "muted"
}

/** Earliest instance creation; missing timestamps sort last. */
function firstCreated(section: Section): number {
  return Math.min(...section.instances.map((one) => one.session.time?.created ?? Infinity))
}

function compareNames(left: Section, right: Section): number {
  const byName = left.name.toLowerCase().localeCompare(right.name.toLowerCase())
  return byName !== 0 ? byName : left.agentID.localeCompare(right.agentID)
}

/**
 * The whole sidebar as data: numbered role rows with tree-glyph instance rows
 * nested under them. Running sessions and sessions inside the failure grace
 * window become instances; every other agent is an idle role row. Body lines
 * are capped at `maxLines`: roles with instances first (oldest instance
 * first), then idle roles alphabetically, so an instance never separates from
 * its role row. The body stops at the first section that does not fit.
 */
export function panel(
  sources: Sources,
  sessionID?: string,
  width = DEFAULT_WIDTH,
  maxLines = BODY_MAX_LINES,
  now = Date.now(),
  graceMs = GRACE_MS,
) {
  const W = effectiveWidth(width)
  const shortLabel = labeler(sources.models, sources.providers, true)
  const roleLabel = (ref: ModelRef | undefined) => (ref ? shortLabel(ref) : "")

  const members = sources.members
  // A missing snapshot is not a fresh decision: no members, no rows (A.8).
  const mode: PanelMode = members?.mode ?? "builtin"
  const memberRoles = members?.roles ?? []
  const memberByID = new Map(memberRoles.map((agent) => [agent.id, agent]))
  const liveAgents = sources.agents ?? []
  const liveByID = new Map(liveAgents.map((agent) => [agent.id, agent]))

  // A visible charter-mode builtin that is not a member becomes a temporary
  // role only while it has an in-scope instance (R2, §2.1). The live entry is
  // its definition (name, model, colour); R8 step 2 also reads the live list.
  const roleFor = (agentID: string): AgentInfo | undefined => {
    const member = memberByID.get(agentID)
    if (member) return member
    if (mode !== "charter" || !BUILTIN_AGENT_IDS.includes(agentID)) return undefined
    const live = liveByID.get(agentID)
    return live && isVisibleRole(live) ? live : undefined
  }

  // No viewed tab means an empty instance set, never every tab (F11).
  const scope = sessionID ? sources.sessions.root(sessionID) : undefined
  const rootCache = new Map<string, string>()
  const rootOf = (id: string) => {
    const cached = rootCache.get(id)
    if (cached !== undefined) return cached
    const value = sources.sessions.root(id)
    rootCache.set(id, value)
    return value
  }

  const sections = new Map<string, Section>()
  if (scope !== undefined) {
    for (const session of sources.sessions.list()) {
      if (!session.parentID || !session.agent) continue
      if (rootOf(session.id) !== scope) continue
      const agent = roleFor(session.agent)
      if (!agent) continue

      const running = sources.sessions.status(session.id) === "running"
      const ended = session.time?.updated ?? session.time?.created
      const stoppedBad = session.outcome === "failed" || session.outcome === "interrupted"
      const elapsedMs = ended === undefined ? undefined : now - ended
      // Half-open: exactly the window length is already folded (F4).
      const inGrace =
        !running &&
        stoppedBad &&
        elapsedMs !== undefined &&
        elapsedMs >= 0 &&
        elapsedMs < graceMs
      const state: "active" | "grace" | undefined = running
        ? "active"
        : inGrace
          ? "grace"
          : undefined
      if (!state) continue

      let entry = sections.get(session.agent)
      if (!entry) {
        entry = {
          agentID: session.agent,
          name: agent.name ?? session.agent,
          color: agent.color,
          model: roleLabel(agent.model),
          instances: [],
        }
        sections.set(session.agent, entry)
      }
      entry.instances.push({ session, state })
    }
  }

  const busy = [...sections.values()]
  busy.sort((left, right) => {
    const a = firstCreated(left)
    const b = firstCreated(right)
    if (a < b) return -1
    if (a > b) return 1
    return compareNames(left, right)
  })
  for (const section of busy) {
    section.instances.sort((left, right) => {
      const a = left.session.time?.created ?? Infinity
      const b = right.session.time?.created ?? Infinity
      if (a < b) return -1
      if (a > b) return 1
      return left.session.id.localeCompare(right.session.id)
    })
  }

  const idle = memberRoles
    .filter((agent) => !sections.has(agent.id))
    .map((agent) => ({
      agentID: agent.id,
      name: agent.name ?? agent.id,
      color: agent.color,
      model: roleLabel(agent.model),
      instances: [],
    }))
  idle.sort(compareNames)

  const rows: PanelRow[] = []
  let more = 0
  let number = 0

  const tpsBySession = new Map<string, number | undefined>()
  const instanceTps = (sessionID: string) => {
    if (!tpsBySession.has(sessionID)) {
      tpsBySession.set(sessionID, speedTps(sources.sessions.message?.list(sessionID) ?? []))
    }
    return tpsBySession.get(sessionID)
  }

  const pushRole = (
    agentName: string,
    model: string,
    state: RowState,
    tps: number | undefined,
    color: string | undefined,
  ) => {
    number += 1
    rows.push({
      head: roleHead(number, agentName, model, W),
      filled: barFill(tps),
      tps,
      state,
      agentColor: color,
    })
  }
  const pushInstance = (
    glyph: "├" | "└",
    instance: Section["instances"][number],
    color?: string,
  ) => {
    // A finished session has no live speed, so a grace row fills nothing (F18).
    const tps = instance.state === "active" ? instanceTps(instance.session.id) : undefined
    rows.push({
      head: instanceHead(
        glyph,
        instance.session.title ?? instance.session.id,
        instanceLabel(instance.session, sources, shortLabel),
        W,
      ),
      filled: barFill(tps),
      tps,
      state: instance.state,
      agentColor: color,
    })
  }

  type RenderableSection = { lines: number; emit: () => void }
  const sectionsToEmit: RenderableSection[] = []

  for (const section of busy) {
    const active = section.instances.some((one) => one.state === "active")
    const state: RowState = active ? "active" : "grace"
    const known = section.instances
      .filter((one) => one.state === "active")
      .map((one) => instanceTps(one.session.id))
      .filter((value): value is number => value !== undefined)
    // The role row carries its busiest active instance's speed, so its boxes
    // take the same single tone as that instance (G13, R6).
    const tps = known.length > 0 ? Math.max(...known) : undefined
    sectionsToEmit.push({
      lines: section.instances.length + 1,
      emit: () => {
        pushRole(section.name, section.model, state, tps, active ? section.color : undefined)
        section.instances.forEach((one, index) => {
          pushInstance(index === section.instances.length - 1 ? "└" : "├", one, section.color)
        })
      },
    })
  }
  for (const role of idle) {
    sectionsToEmit.push({
      lines: 1,
      emit: () => pushRole(role.name, role.model, "idle", undefined, role.color),
    })
  }

  for (let index = 0; index < sectionsToEmit.length; index++) {
    const section = sectionsToEmit[index]
    if (rows.length + section.lines > maxLines) {
      // First non-fitting section stops the body: it and every later section fold.
      for (let rest = index; rest < sectionsToEmit.length; rest++) {
        more += sectionsToEmit[rest].lines
      }
      break
    }
    section.emit()
  }

  return {
    rows,
    more,
    working: busy.filter((section) => section.instances.some((one) => one.state === "active"))
      .length,
    total: memberRoles.length,
    mode,
  }
}

/** Instance model label: R8 resolution's short label, else `unknown model`. */
function instanceLabel(
  session: SessionInfo,
  sources: Sources,
  shortLabel: (ref: ModelRef) => string,
): string {
  const ref = modelRef(session, sources)
  return ref ? shortLabel(ref) : UNKNOWN_MODEL
}

/** `42s`, `3m`, `1h 2m`. Empty when the start time is unknown. */
export function elapsed(since: number | undefined, now = Date.now()): string {
  if (!since) return ""
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** Case-insensitive substring match across `fields`. An empty query always matches. */
export function matches(query: string | undefined, ...fields: string[]): boolean {
  const needle = query?.trim().toLowerCase()
  if (!needle) return true
  return fields.join(" ").toLowerCase().includes(needle)
}

/** Case-insensitive match on agent, model, title, elapsed text, and session ID. */
export function filterRows(
  rows: RunningSubagent[],
  query: string | undefined,
  now = Date.now(),
): RunningSubagent[] {
  return rows.filter((row) =>
    matches(query, row.agent, row.model, row.title, elapsed(row.since, now), row.sessionID),
  )
}
