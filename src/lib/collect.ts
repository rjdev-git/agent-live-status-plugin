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
  limit?: { context: number }
}

/** The part of a message's usage that fills the context window. */
export type TokenUsage = {
  input: number
  cache?: { read?: number }
}

export type ProviderInfo = {
  id: string
  name: string
}

export type AgentInfo = {
  id: string
  model?: ModelRef
}

export type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
  model?: ModelRef
  title?: string
  time?: { created?: number }
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
}

export type RunningSubagent = {
  sessionID: string
  agent: string
  model: string
  title: string
  since?: number
  /** Short `Provider/Model` label used by the sidebar rows. */
  modelShort?: string
  /** Context window used, 0-100. Unknown when the usage or limit is missing. */
  pct?: number
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

/** Context window size for the model a session resolves to. */
function contextLimit(ref: ModelRef | undefined, models: ModelInfo[] = []): number | undefined {
  if (!ref) return undefined
  const model = models.find(
    (entry) => entry.providerID === ref.providerID && (entry.modelID === ref.id || entry.id === ref.id),
  )
  return model?.limit?.context
}

/** Usage of the newest message that reports tokens; older ones predate it. */
function lastUsage(sources: Sources, sessionID: string): TokenUsage | undefined {
  const list = sources.sessions.message?.list(sessionID) ?? []
  for (let index = list.length - 1; index >= 0; index--) {
    const usage = (list[index] as { tokens?: TokenUsage } | undefined)?.tokens
    if (usage) return usage
  }
  return undefined
}

/**
 * Context window used, 0-100, from the newest message's prompt size over the
 * model limit. Cumulative session tokens are wrong here: they never fall
 * after compaction.
 */
export function contextPct(session: SessionInfo, sources: Sources): number | undefined {
  const limit = contextLimit(modelRef(session, sources), sources.models)
  const usage = lastUsage(sources, session.id)
  if (!limit || !usage) return undefined
  const used = usage.input + (usage.cache?.read ?? 0)
  if (!Number.isFinite(used) || used < 0) return undefined
  return Math.min(100, (used / limit) * 100)
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
      pct: contextPct(session, sources),
      title: cleanTitle(session.title ?? session.id),
      since: session.time?.created,
    })
  }

  return rows
}

type Tally = { value: string; count: number }

function tally(values: string[]): Tally[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].map(([value, count]) => ({ value, count }))
}

function withCount(entry: Tally): string {
  return entry.count > 1 ? `${entry.value} x${entry.count}` : entry.value
}

/**
 * One row: `sub explore · Provider/Model (high)`.
 * Several: `sub 3 · explore · Provider/Model (high) x3`.
 */
export function summary(rows: RunningSubagent[]): string {
  if (rows.length === 0) return ""
  if (rows.length === 1) return `sub ${rows[0].agent} · ${rows[0].model}`

  const agents = tally(rows.map((row) => row.agent))
  const models = tally(rows.map((row) => row.model))
  const agentPart = agents.length === 1 ? agents[0].value : agents.map(withCount).join(", ")
  return `sub ${rows.length} · ${agentPart} · ${models.map(withCount).join(", ")}`
}

/** `42s`, `3m`, `1h 2m`. Empty when the start time is unknown. */
/** Sidebar row budget. Numbers are reserved for two digits, so rows stay aligned. */
export const MAX_ROWS = 20

/** Width of the context indicator, in boxes. */
export const BAR_CELLS = 5

/** Agent names are clipped to this many cells so the model column aligns. */
export const AGENT_CELLS = 9

/** Everything in a row except the model label: number, agent, spaces, boxes. */
const ROW_FIXED_CELLS = 19

export type RowLayout = {
  /** Number, agent, model, and the gap before the boxes. */
  head: string
  /** Filled boxes, 0-5. */
  filled: number
  /** Context used, 0-100. Unknown when the session reports no usage. */
  pct?: number
}

/** Hard cap on the model label, so a wide sidebar does not stretch it. */
const MAX_MODEL_CELLS = 20

/**
 * Fits `Provider/Model` into `budget` cells. When it overflows, the provider
 * may take at most half; the rest goes to the model name, so a long provider
 * cannot eat the model.
 */
export function fitModel(label: string, budget: number): string {
  if (label.length <= budget) return label
  const slash = label.indexOf("/")
  if (slash < 0) return truncate(label, budget)

  const provider = label.slice(0, slash)
  const model = label.slice(slash + 1)
  const providerCells = Math.max(1, Math.floor(budget / 2) - 1)
  const shownProvider = truncate(provider, providerCells)
  const modelCells = Math.max(1, budget - shownProvider.length - 1)
  return `${shownProvider}/${truncate(model, modelCells)}`
}

/**
 * Numbered sidebar rows plus the count of rows past the cap. Oldest first, so
 * a new subagent appends at the bottom and numbering stays stable.
 */
export function layout(rows: RunningSubagent[], width = 35, max = MAX_ROWS) {
  const budget = Math.max(4, Math.min(MAX_MODEL_CELLS, width - ROW_FIXED_CELLS))
  const ordered = [...rows].sort((left, right) => (left.since ?? Infinity) - (right.since ?? Infinity))
  const shown = ordered.slice(0, max)

  return {
    rows: shown.map((row, index): RowLayout => {
      const agent = truncate(row.agent, AGENT_CELLS).padEnd(AGENT_CELLS)
      const model = fitModel(row.modelShort ?? row.model, budget).padEnd(budget)
      const filled =
        row.pct === undefined
          ? 0
          : Math.min(BAR_CELLS, Math.max(0, Math.round((row.pct * BAR_CELLS) / 100)))
      const number = String(index + 1).padStart(2)
      return { head: `${number}.${agent} ${model} `, filled, pct: row.pct }
    }),
    more: Math.max(0, ordered.length - shown.length),
  }
}

export function elapsed(since: number | undefined, now = Date.now()): string {
  if (!since) return ""
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value
  if (width === 1) return "…"
  return `${value.slice(0, width - 1)}…`
}

/** Case-insensitive substring match across `fields`. An empty query always matches. */
export function matches(query: string | undefined, ...fields: string[]): boolean {
  const needle = query?.trim().toLowerCase()
  if (!needle) return true
  return fields.join(" ").toLowerCase().includes(needle)
}

/** Case-insensitive match on agent, model, title, and session ID. */
export function filterRows(rows: RunningSubagent[], query: string | undefined): RunningSubagent[] {
  return rows.filter((row) => matches(query, row.agent, row.model, row.title, row.sessionID))
}
