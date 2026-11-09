import assert from "node:assert/strict"
import test from "node:test"
import {
  BAR_CELLS,
  BAR_GLYPH_EMPTY,
  BAR_GLYPH_FILLED,
  BODY_MAX_LINES,
  BUILTIN_AGENT_IDS,
  BUILTIN_TAG_TEXT,
  CELL_PX,
  DEFAULT_WIDTH,
  ELLIPSIS_CELLS,
  FILL_BANDS,
  FILL_MAX_BOXES,
  FILL_MIN_BOXES,
  GRACE_MS,
  GRACE_TICK_MS,
  INSTANCE_BAR_GAP_CELLS,
  INSTANCE_FIXED_CELLS,
  INSTANCE_INDENT_CELLS,
  INSTANCE_MODEL_CELLS,
  INSTANCE_MODEL_MIN_CELLS,
  INSTANCE_REST_FIXED_CELLS,
  INSTANCE_TITLE_CELLS,
  INSTANCE_TITLE_GAP_CELLS,
  INSTANCE_TITLE_MIN_CELLS,
  INSTANCE_TITLE_SHARE_DEN,
  INSTANCE_TITLE_SHARE_NUM,
  PICKER_AGENT_CELLS,
  PICKER_MODEL_CELLS,
  PROVIDER_MAX_SHARE,
  ROLE_BAR_GAP_CELLS,
  ROLE_FIXED_CELLS,
  ROLE_MODEL_MAX_CELLS,
  ROLE_MODEL_MIN_CELLS,
  ROLE_NAME_CELLS,
  ROLE_NAME_GAP_CELLS,
  ROLE_NAME_MIN_CELLS,
  ROLE_NAME_SHARE_DEN,
  ROLE_NAME_SHARE_NUM,
  ROLE_NUMBER_CELLS,
  ROLE_NUMBER_DIGITS,
  ROLE_REST_FIXED_CELLS,
  UNKNOWN_MODEL,
  barFill,
  barTone,
  cellWidth,
  cleanTitle,
  clip,
  collect,
  debugDumpPath,
  detectedCells,
  elapsed,
  fitModel,
  filterRows,
  instanceSplit,
  labeler,
  isVisibleRole,
  memberSet,
  panel,
  matches,
  pickerTitle,
  resolveCellPx,
  resolveModel,
  roleSplit,
  rowWidth,
  runtimeCellPx,
  selectCells,
  speedTps,
  type AgentInfo,
  type MemberSet,
  type RunningSubagent,
  type RuntimeMetrics,
  type SessionInfo,
  type SessionSource,
  type Sources,
  type WidthProbe,
} from "./collect.ts"

/** One message fixture, shaped like the host's assistant messages (R6, §2). */
type TestMessage = {
  type?: string
  tokens?: { output?: number }
  time?: { created?: number; streamed?: number; completed?: number }
}

/** One counted assistant message: `ms = completed - streamed`. */
function assistant(
  output: number,
  streamed: number,
  completed: number,
  extra: Partial<TestMessage> = {},
): TestMessage {
  return {
    type: "assistant",
    tokens: { output },
    time: { created: streamed, streamed, completed },
    ...extra,
  }
}

function fakeSessions(
  sessions: SessionInfo[],
  running: string[] = [],
  messages: Record<string, ReadonlyArray<TestMessage>> = {},
): SessionSource {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  return {
    list: () => sessions,
    get: (id) => byID.get(id),
    root: (id) => {
      let current = byID.get(id)
      let guard = 0
      while (current?.parentID && guard++ < 32) {
        const parent = byID.get(current.parentID)
        if (!parent) break
        current = parent
      }
      return current?.id ?? id
    },
    status: (id) => (running.includes(id) ? "running" : "idle"),
    message: { list: (id) => messages[id] ?? [] },
  }
}

const models = [
  { id: "deepseek-flash", modelID: "deepseek-flash", providerID: "deepseek", name: "DeepSeek Flash" },
]
const providers = [{ id: "deepseek", name: "DeepSeek" }]

/** An agent that survives the R2 filter. */
function agent(id: string, name: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return { id, name, mode: "subagent", ...extra }
}

/** A child session of `root`, drawn with a created time. */
function child(
  id: string,
  agentID: string,
  created: number,
  extra: Partial<SessionInfo> = {},
): SessionInfo {
  return { id, parentID: "root", agent: agentID, title: id, time: { created }, ...extra }
}

/** Sources whose family root is `root`, so `panel(..., "root")` is in scope. */
function rootSources(
  sessions: SessionInfo[],
  agents: AgentInfo[],
  running: string[] = [],
  messages: Record<string, ReadonlyArray<TestMessage>> = {},
  members: MemberSet = memberSet(agents),
): Sources {
  return {
    sessions: fakeSessions([{ id: "root" }, ...sessions], running, messages),
    agents,
    models,
    providers,
    members,
  }
}

test("labeler formats provider/model and appends the variant", () => {
  const label = labeler(models, providers)
  assert.equal(label({ id: "deepseek-flash", providerID: "deepseek" }), "DeepSeek/DeepSeek Flash")
  assert.equal(
    label({ id: "deepseek-flash", providerID: "deepseek", variant: "high" }),
    "DeepSeek/DeepSeek Flash (high)",
  )
})

test("labeler falls back to raw ids", () => {
  const label = labeler([], [])
  assert.equal(label({ id: "mystery", providerID: "unknown-provider" }), "unknown-provider/mystery")
})

test("short labeler keeps the provider's last word and drops the variant", () => {
  const label = labeler(
    [{ id: "kimi", modelID: "kimi", providerID: "go", name: "Kimi K3.1 Pro" }],
    [{ id: "go", name: "OpenCode Go" }],
    true,
  )
  assert.equal(label({ id: "kimi", providerID: "go", variant: "high" }), "Go/Kimi K3.1 Pro")
})

test("speedTps uses only assistant messages with a measured stream window", () => {
  assert.equal(speedTps([assistant(200, 1000, 2000)]), 200)
  // Skipped whole: no tokens, no timing, a backwards window, or a wrong type.
  assert.equal(speedTps([{ type: "assistant", time: { created: 0, streamed: 0, completed: 1_000 } }]), undefined)
  assert.equal(speedTps([{ type: "assistant", tokens: { output: 200 } }]), undefined)
  assert.equal(speedTps([assistant(200, 1000, 500)]), undefined)
  assert.equal(speedTps([{ ...assistant(200, 0, 1_000), type: "user" }]), undefined)
  // streamed must be at or after created.
  assert.equal(
    speedTps([
      { type: "assistant", tokens: { output: 200 }, time: { created: 1_000, streamed: 500, completed: 2_000 } },
    ]),
    undefined,
  )
  // A counted zero-output message is a known 0, not unknown.
  assert.equal(speedTps([assistant(0, 0, 1_000)]), 0)
  // An invalid message contributes neither tokens nor time.
  assert.equal(speedTps([assistant(100, 0, 1_000), assistant(900, 1_000, 500)]), 100)
})

test("resolveModel prefers the session model", () => {
  const sources: Sources = {
    sessions: fakeSessions([{ id: "s1", model: { id: "deepseek-flash", providerID: "deepseek" } }]),
    models,
    providers,
  }
  assert.equal(
    resolveModel(sources.sessions.list()[0], sources),
    "DeepSeek/DeepSeek Flash",
  )
})

test("resolveModel falls back to the agent model", () => {
  const sources: Sources = {
    sessions: fakeSessions([{ id: "s1", agent: "explore" }]),
    agents: [{ id: "explore", model: { id: "deepseek-flash", providerID: "deepseek", variant: "high" } }],
    models,
    providers,
  }
  assert.equal(
    resolveModel(sources.sessions.list()[0], sources),
    "DeepSeek/DeepSeek Flash (high)",
  )
})

test("resolveModel walks to the nearest ancestor with a model", () => {
  const sources: Sources = {
    sessions: fakeSessions([
      { id: "root", model: { id: "deepseek-flash", providerID: "deepseek" } },
      { id: "mid", parentID: "root" },
      { id: "leaf", parentID: "mid" },
    ]),
    models,
    providers,
  }
  const leaf = sources.sessions.get("leaf")!
  assert.equal(resolveModel(leaf, sources), "DeepSeek/DeepSeek Flash")
})

test("resolveModel survives a parent cycle", () => {
  const sessions: SessionInfo[] = [
    { id: "a", parentID: "b" },
    { id: "b", parentID: "a" },
  ]
  const sources: Sources = { sessions: fakeSessions(sessions) }
  assert.equal(resolveModel(sessions[0], sources), "unknown model")
})

test("collect keeps only running children of the viewed family", () => {
  const sources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root" },
        { id: "child", parentID: "root", agent: "explore", title: "Inspect\nrepo" },
        { id: "idle-child", parentID: "root", agent: "explore" },
        { id: "other-child", parentID: "other", agent: "general" },
      ],
      ["child", "other-child"],
    ),
    models,
    providers,
  }

  const scoped = collect(sources, "root")
  assert.deepEqual(
    scoped.map((row) => row.sessionID),
    ["child"],
  )
  assert.equal(scoped[0].title, "Inspect repo")

  assert.equal(collect(sources).length, 2)
  assert.deepEqual(collect(sources, "missing"), [])
})

test("fitModel gives the provider half at most and the model the rest", () => {
  assert.equal(fitModel("Go/Kimi K3.1 Pro", 16), "Go/Kimi K3.1 Pro")
  assert.equal(fitModel("Go/MiniMax M3.1 Flash", 16), "Go/MiniMax M3.1…")
  assert.equal(fitModel("SomeVeryBigName/Model", 16), "SomeVe…/Model")
  assert.equal(fitModel("SomeVeryBigName/SomeVeryLongModelNameRight", 16), "SomeVe…/SomeVer…")
  assert.equal(fitModel("NoSlashModelNameLongerThanBudget", 16), "NoSlashModelNam…")
})

test("instance rows show an 8-cell title and a 12-cell model", () => {
  const NOW = 1_000_000
  // The role has no baseline model, so the instance label is shown (A.10).
  const agents = [{ id: "aa", name: "Alpha", mode: "subagent" }]
  const sources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root" },
        {
          id: "long-title",
          parentID: "root",
          agent: "aa",
          title: "Inspect modules thoroughly",
          model: { id: "deepseek-flash", providerID: "deepseek" },
          time: { created: NOW },
        },
      ],
      ["long-title"],
    ),
    agents,
    models,
    providers,
    members: memberSet(agents),
  }

  const view = panel(sources, "root", 35, 10, NOW)
  const instance = view.rows.find((row) => row.head.startsWith(" └"))!
  assert.equal(instance.head, " └ Inspect… Deep…/DeepS…      ")
  assert.equal(cellWidth(instance.head) + 5, 35)
})

test("elapsed buckets seconds, minutes, and hours", () => {
  assert.equal(elapsed(undefined), "")
  assert.equal(elapsed(1_000, 43_000), "42s")
  assert.equal(elapsed(0, 43_000), "")
  assert.equal(elapsed(1_000, 181_000), "3m")
  assert.equal(elapsed(1_000, 3_721_000), "1h 2m")
})

test("cleanTitle collapses whitespace", () => {
  assert.equal(cleanTitle("  a\n\nb\t c "), "a b c")
})

test("panel lists roles, nests working instances, and hides expired failures", () => {
  const agents = [
    { id: "zz", name: "Zeta", mode: "subagent" },
    { id: "aa", name: "Alpha", mode: "subagent", color: "#00ff00", model: { id: "deepseek-flash", providerID: "deepseek" } },
    { id: "hidden", name: "Hidden", mode: "subagent", hidden: true },
    { id: "primary", name: "Lead", mode: "primary" },
  ]
  const NOW = 1_000_000
  const sources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root", parentID: undefined },
        {
          id: "work",
          parentID: "root",
          agent: "aa",
          title: "Doing work",
          model: { id: "deepseek-flash", providerID: "deepseek" },
          time: { created: NOW - 12_000, updated: NOW - 1_000 },
        },
        {
          id: "failed-a",
          parentID: "root",
          agent: "zz",
          title: "Broke",
          outcome: "failed",
          time: { created: NOW - 20_000, updated: NOW - 15_000 },
        },
        {
          id: "failed-old",
          parentID: "root",
          agent: "zz",
          title: "Old failure",
          outcome: "failed",
          time: { created: NOW - 120_000, updated: NOW - 60_000 },
        },
      ],
      ["work"],
    ),
    agents,
    models,
    providers,
    members: memberSet(agents),
  }

  const view = panel(sources, "root", 35, 10, NOW)
  assert.equal(view.working, 1)
  assert.equal(view.total, 2)
  assert.deepEqual(
    view.rows.map((row) => [row.state, row.agentColor]),
    [
      ["grace", undefined],
      ["grace", undefined],
      ["active", "#00ff00"],
      ["active", "#00ff00"],
    ],
  )
  // Grace-bearing roles order with active roles by their oldest instance (F2).
  assert.match(view.rows[0].head, /^ 1\.Zeta /)
  assert.match(view.rows[1].head, /^ └ Broke/)
  assert.match(view.rows[2].head, /^ 2\.Alpha /)
  assert.match(view.rows[3].head, /^ └ Doing w/)
  assert.equal(view.rows[2].filled, 0)
  for (const row of view.rows) assert.equal(cellWidth(row.head) + 5, 35)
})

test("panel caps the body and folds nothing under an incomplete role", () => {
  const agents = Array.from({ length: 12 }, (_, index) => ({
    id: `agent${index}`,
    name: `Agent${index}`,
    mode: "subagent" as const,
  }))
  const sources: Sources = { sessions: fakeSessions([]), agents, members: memberSet(agents) }
  const view = panel(sources, undefined, 35, 10, 0)
  assert.equal(view.rows.length, 10)
  assert.equal(view.more, 2)
  assert.equal(view.rows[0].head, " 1.Agent0                     ")
})

test("panel falls back to the agent or session model for the role row", () => {
  const agents = [{ id: "alpha", name: "Alpha", mode: "subagent", model: { id: "deepseek-flash", providerID: "deepseek" } }]
  const sources: Sources = { sessions: fakeSessions([]), agents, models, providers, members: memberSet(agents) }
  const view = panel(sources, undefined, 35, 10, 0)
  assert.match(view.rows[0].head, /DeepSe/)
})

test("filterRows matches agent, model, and title case-insensitively", () => {
  const rows = [
    { sessionID: "ses_1", agent: "explore", model: "DeepSeek/Flash", title: "Inspect repo" },
    { sessionID: "ses_2", agent: "general", model: "OpenAI/GPT", title: "Write tests" },
  ]
  assert.equal(filterRows(rows, "EXPLORE").length, 1)
  assert.equal(filterRows(rows, "gpt")[0].sessionID, "ses_2")
  assert.equal(filterRows(rows, "tests")[0].sessionID, "ses_2")
  assert.equal(filterRows(rows, "   ").length, 2)
})

test("filterRows matches the elapsed text", () => {
  const rows: RunningSubagent[] = [
    { sessionID: "ses_1", agent: "explore", model: "DeepSeek/Flash", title: "a", since: 1_000 },
  ]
  assert.equal(filterRows(rows, "42s", 43_000).length, 1)
  assert.equal(filterRows(rows, "43s", 43_000).length, 0)
})

test("matches spans every field and ignores case and padding", () => {
  assert.equal(matches("EXPLORE", "explore · DeepSeek/Flash", "Inspect repo"), true)
  assert.equal(matches(" ses_2 ", "general · OpenAI/GPT", "Write tests", "ses_2"), true)
  assert.equal(matches("missing", "general · OpenAI/GPT"), false)
  assert.equal(matches(undefined, "anything"), true)
  assert.equal(matches("", "anything"), true)
})

/* ------------------------------------------------------------------ */
/* §6 contract numbers, C1-C29, each with a fits and a does-not-fit side. */
/* ------------------------------------------------------------------ */

function runningRole(id: string, name: string, count: number, start: number) {
  const sessions = Array.from({ length: count }, (_, index) =>
    child(`${id}-${index}`, id, start + index),
  )
  return { agent: agent(id, name), sessions, running: sessions.map((session) => session.id) }
}

function roleWithModel(providerName: string, modelName: string): Sources {
  const agents = [agent("a", "A", { model: { id: "m", providerID: "p" } })]
  return {
    sessions: fakeSessions([{ id: "root" }]),
    agents,
    models: [{ id: "m", modelID: "m", providerID: "p", name: modelName }],
    providers: [{ id: "p", name: providerName }],
    members: memberSet(agents),
  }
}

test("C1 BODY_MAX_LINES = 10 caps the body and counts folded lines", () => {
  assert.equal(BODY_MAX_LINES, 10)
  const names = (count: number) => Array.from({ length: count }, (_, index) => `A${index}`)

  const fits = panel(rootSources([], names(10).map((name, index) => agent(`a${index}`, name))), undefined, 35, BODY_MAX_LINES, 0)
  assert.equal(fits.rows.length, 10)
  assert.equal(fits.more, 0)

  const overflow = panel(rootSources([], names(11).map((name, index) => agent(`a${index}`, name))), undefined, 35, BODY_MAX_LINES, 0)
  assert.equal(overflow.rows.length, 10)
  assert.equal(overflow.more, 1)
})

test("C2 DEFAULT_WIDTH = 35 when the width option is absent", () => {
  assert.equal(DEFAULT_WIDTH, 35)
  const role = runningRole("aa", "Alpha", 1, 100)
  const sources = rootSources(role.sessions, [role.agent], role.running)

  const unset = panel(sources, "root")
  assert.equal(cellWidth(unset.rows[0].head), 30)
  assert.equal(cellWidth(unset.rows[1].head), 30)

  const narrow = panel(sources, "root", 30)
  assert.equal(cellWidth(narrow.rows[0].head), 25)
  assert.equal(cellWidth(narrow.rows[1].head), 25)
})

test("C3 ROLE_NUMBER_DIGITS = 2", () => {
  assert.equal(ROLE_NUMBER_DIGITS, 2)
  const agents = Array.from({ length: 10 }, (_, index) => agent(`a${index}`, `A${index}`))
  const view = panel(rootSources([], agents), undefined, 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[8].head.slice(0, 3), " 9.")
  // The tenth role is the highest emitted number: the body cap stops at 10.
  assert.equal(view.rows[9].head.slice(0, 3), "10.")
  assert.equal(view.rows.length, 10)
})

test("C4 ROLE_NUMBER_CELLS = 3", () => {
  assert.equal(ROLE_NUMBER_CELLS, 3)
  const agents = Array.from({ length: 10 }, (_, index) => agent(`a${index}`, `A${index}`))
  const view = panel(rootSources([], agents), undefined, 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[0].head.slice(0, 3), " 1.")
  assert.equal(view.rows[9].head.slice(0, 3), "10.")
  assert.equal(cellWidth(view.rows[9].head.slice(0, 3)), ROLE_NUMBER_CELLS)
})

test("C5 ROLE_NAME_CELLS = 9 clips names with an ellipsis", () => {
  assert.equal(ROLE_NAME_CELLS, 9)
  const nameAt = (value: string) =>
    panel(rootSources([], [agent("a", value)]), undefined, 35, BODY_MAX_LINES, 0).rows[0].head.slice(3, 12)

  assert.equal(nameAt("explore"), "explore  ")
  assert.equal(nameAt("123456789"), "123456789")
  assert.equal(nameAt("1234567890"), "12345678…")
  // Hostile width: a 10-cell wide name must still fit the 9-cell field.
  assert.equal(clip("调研团队组", ROLE_NAME_CELLS), "调研团队…")
  const wideHead = panel(rootSources([], [agent("a", "调研团队组")]), undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(wideHead.startsWith(" 1.调研团队…"), true)
  assert.equal(cellWidth("调研团队…"), 9)
})

test("C6 ROLE_NAME_GAP_CELLS = 1 keeps the gap column clear", () => {
  assert.equal(ROLE_NAME_GAP_CELLS, 1)
  // A non-builtin id: built-in role rows show the tag instead (A.9).
  const agents = [agent("coder", "explore", { model: { id: "kimi", providerID: "go" } })]
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }]),
    agents,
    models: [{ id: "kimi", modelID: "kimi", providerID: "go", name: "Kimi K3.1 Pro" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
    members: memberSet(agents),
  }
  const head = panel(sources, undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(head, " 1.explore   Go/Kimi K3.1 Pro ")
  assert.equal(cellWidth(head), 30)
  // Column 13 is the gap: a gap-less row would start the model there.
  assert.equal(head[12], " ")
  assert.notEqual(head, " 1.explore  Go/Kimi K3.1 Pro  ")
  assert.equal(cellWidth(" 1.explore  Go/Kimi K3.1 Pro  "), 30)
})

test("C7 ROLE_MODEL_MAX_CELLS = 20 caps the role label text", () => {
  assert.equal(ROLE_MODEL_MAX_CELLS, 20)
  // Width 40: the role column is 21 cells but the label text stops at 20.
  const twenty = panel(roleWithModel("P", "123456789012345678"), undefined, 40, BODY_MAX_LINES, 0)
  assert.equal(twenty.rows[0].head.slice(13, 33), "P/123456789012345678")

  const twentyOne = panel(roleWithModel("P", "1234567890123456789"), undefined, 40, BODY_MAX_LINES, 0)
  assert.equal(twentyOne.rows[0].head.slice(13, 33), "P/12345678901234567…")
})

test("C8 ROLE_FIXED_CELLS = 19 leaves the model column and raises narrow widths", () => {
  assert.equal(ROLE_FIXED_CELLS, 19)
  const at19 = panel(rootSources([], [agent("a", "A")]), undefined, 19, BODY_MAX_LINES, 0)
  assert.equal(cellWidth(at19.rows[0].head), 14)
  assert.equal(cellWidth(at19.rows[0].head.slice(13)), 1)

  const at18 = panel(rootSources([], [agent("a", "A")]), undefined, 18, BODY_MAX_LINES, 0)
  assert.equal(cellWidth(at18.rows[0].head), 14)
})

test("C9 BAR_CELLS = 5 boxes", () => {
  assert.equal(BAR_CELLS, 5)
  assert.equal(barFill(1000), BAR_CELLS)
  assert.equal(barFill(undefined), 0)
  assert.equal(BAR_CELLS - barFill(undefined), 5)
})

test("C10 INSTANCE_INDENT_CELLS = 3 with the tree glyphs", () => {
  assert.equal(INSTANCE_INDENT_CELLS, 3)
  const agents = [agent("a", "A")]
  const sources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root" },
        {
          id: "i1",
          parentID: "root",
          agent: "a",
          title: "Inspect modules",
          model: { id: "grok47", providerID: "go" },
          time: { created: 100 },
        },
        {
          id: "i2",
          parentID: "root",
          agent: "a",
          title: "Inspect modules",
          model: { id: "grok47", providerID: "go" },
          time: { created: 200 },
        },
      ],
      ["i1", "i2"],
    ),
    agents,
    models: [{ id: "grok47", modelID: "grok47", providerID: "go", name: "Grok 4.7" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
    members: memberSet(agents),
  }
  const view = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  const first = view.rows[1].head
  const last = view.rows[2].head
  assert.equal(first, " ├ Inspect… Go/Grok 4.7       ")
  assert.equal(cellWidth(first), 30)
  assert.equal(first.slice(0, 3), " ├ ")
  assert.equal(first[3], "I")
  assert.equal(last, " └ Inspect… Go/Grok 4.7       ")
  // Both failure directions: └ on a non-last row, ├ on the last row.
  assert.notEqual(first.slice(0, 3), " └ ")
  assert.notEqual(last.slice(0, 3), " ├ ")
  // A two-cell indent would shift the title into the glyph column.
  assert.notEqual(first.slice(0, 3), " ├I")
})

test("C11 INSTANCE_TITLE_CELLS = 8 clips title text", () => {
  assert.equal(INSTANCE_TITLE_CELLS, 8)
  assert.equal(clip("Inspect modules", 8), "Inspect…")
  assert.equal(clip("abcdefgh", 8), "abcdefgh")
  assert.equal(clip("abcdefghi", 8), "abcdefg…")
  // Hostile width: a 10-cell wide title clips to 7 cells.
  assert.equal(clip("调研团队组", 8), "调研团…")

  const role = runningRole("aa", "Alpha", 1, 100)
  const session = {
    ...role.sessions[0],
    title: "abcdefghi",
    // A.10 shows the label because the role has no model, so C11's 8-cell
    // shown-row cap applies (A.13 scopes it to shown-model rows).
    model: { id: "deepseek-flash", providerID: "deepseek" },
  }
  const view = panel(rootSources([session], [role.agent], role.running), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[1].head.slice(3, 11), "abcdefg…")
})

test("C12 INSTANCE_TITLE_GAP_CELLS = 1 after the title field", () => {
  assert.equal(INSTANCE_TITLE_GAP_CELLS, 1)
  const role = runningRole("aa", "Alpha", 1, 100)
  const session = {
    ...role.sessions[0],
    title: "abcdefghi",
    // Shown-model row: the gap column follows the 8-cell title field (C12).
    model: { id: "deepseek-flash", providerID: "deepseek" },
  }
  const view = panel(rootSources([session], [role.agent], role.running), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[1].head[11], " ")
  assert.equal(view.rows[1].head.slice(3, 11), "abcdefg…")
})

test("C13 INSTANCE_MODEL_CELLS = 12 uses the split rule", () => {
  assert.equal(INSTANCE_MODEL_CELLS, 12)
  assert.equal(fitModel("OpenCode/Kimi K3.1 Pro", 12), "Open…/Kimi …")
  assert.equal(clip("OpenCode/Kimi K3.1 Pro", 12), "OpenCode/Ki…")
  assert.notEqual(fitModel("OpenCode/Kimi K3.1 Pro", 12), clip("OpenCode/Kimi K3.1 Pro", 12))

  const agents = [agent("a", "A")]
  const sources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root" },
        {
          id: "kimi",
          parentID: "root",
          agent: "a",
          title: "x",
          model: { id: "kimi-k31", providerID: "opencode" },
          time: { created: 100 },
        },
      ],
      ["kimi"],
    ),
    agents,
    models: [{ id: "kimi-k31", modelID: "kimi-k31", providerID: "opencode", name: "Kimi K3.1 Pro" }],
    providers: [{ id: "opencode", name: "OpenCode" }],
    members: memberSet(agents),
  }
  const view = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[1].head.slice(12, 30), "Open…/Kimi …      ")
  assert.equal(cellWidth(view.rows[1].head.slice(12, 30)), 18)
})

test("C14 INSTANCE_FIXED_CELLS = 18 leaves the model column", () => {
  assert.equal(INSTANCE_FIXED_CELLS, 18)
  const role = runningRole("aa", "Alpha", 1, 100)
  const wide = panel(rootSources(role.sessions, [role.agent], role.running), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(cellWidth(wide.rows[1].head.slice(12, 30)), 18)

  const narrow = panel(rootSources(role.sessions, [role.agent], role.running), "root", 18, BODY_MAX_LINES, 0)
  assert.equal(cellWidth(narrow.rows[1].head), 14)
  assert.equal(cellWidth(narrow.rows[1].head.slice(12, 14)), 2)
})

test("C15 one separator cell sits between the model column and the boxes", () => {
  assert.equal(ROLE_BAR_GAP_CELLS, 1)
  assert.equal(INSTANCE_BAR_GAP_CELLS, 1)

  const roleHead = (id: string, name: string) => {
    // A non-builtin id keeps the member model rule under test (A.9).
    const agents = [agent("coder", "explore", { model: { id, providerID: "go" } })]
    return panel(
      {
        sessions: fakeSessions([{ id: "root" }]),
        agents,
        models: [{ id, modelID: id, providerID: "go", name }],
        providers: [{ id: "go", name: "OpenCode Go" }],
        members: memberSet(agents),
      },
      undefined,
      35,
      BODY_MAX_LINES,
      0,
    ).rows[0].head
  }

  // Fits: an 11-cell label leaves 5 pad cells in the 16-cell column, then the
  // separator, so the head ends with 6 spaces.
  assert.equal(roleHead("grok47", "Grok 4.7"), " 1.explore   Go/Grok 4.7      ")
  assert.equal(cellWidth(roleHead("grok47", "Grok 4.7")), 30)
  // A 16-cell label fills the column; the separator is the 30th cell.
  assert.equal(roleHead("kimi", "Kimi K3.1 Pro"), " 1.explore   Go/Kimi K3.1 Pro ")
  assert.equal(cellWidth(roleHead("kimi", "Kimi K3.1 Pro")), 30)

  // Does not fit: a 17-cell label clips to 16 then takes the separator.
  assert.equal(roleHead("grok47f", "Grok 4.7 Flash"), " 1.explore   Go/Grok 4.7 Fla… ")
  assert.equal(cellWidth(roleHead("grok47f", "Grok 4.7 Flash")), 30)
  // A.3's no-separator column of 17 keeps the label whole and must fail.
  assert.notEqual(roleHead("grok47f", "Grok 4.7 Flash"), " 1.explore   Go/Grok 4.7 Flash")
  assert.equal(cellWidth(" 1.explore   Go/Grok 4.7 Flash"), 30)
  // A model field that eats the separator renders a 29-cell head and must
  // fail the 6-space pin.
  assert.notEqual(roleHead("grok47f", "Grok 4.7 Flash"), " 1.explore   Go/Grok 4.7     ")
  assert.equal(cellWidth(" 1.explore   Go/Grok 4.7     "), 29)

  const instanceHead = (id: string, name: string) => {
    const agents = [agent("a", "A")]
    return panel(
      {
        sessions: fakeSessions(
          [
            { id: "root" },
            {
              id: "g",
              parentID: "root",
              agent: "a",
              title: "Inspect modules",
              model: { id, providerID: "go" },
              time: { created: 100 },
            },
            {
              id: "g2",
              parentID: "root",
              agent: "a",
              title: "Inspect modules",
              model: { id, providerID: "go" },
              time: { created: 200 },
            },
          ],
          ["g", "g2"],
        ),
        agents,
        models: [{ id, modelID: id, providerID: "go", name }],
        providers: [{ id: "go", name: "OpenCode Go" }],
        members: memberSet(agents),
      },
      "root",
      35,
      BODY_MAX_LINES,
      0,
    ).rows[1].head
  }

  // Fits: 12-cell text + 5 pad + 1 separator in the 17-cell column.
  assert.equal(instanceHead("grok47", "Grok 4.7"), " ├ Inspect… Go/Grok 4.7       ")
  assert.equal(cellWidth(instanceHead("grok47", "Grok 4.7")), 30)
  assert.equal(instanceHead("kimi", "Kimi K3.1"), " ├ Inspect… Go/Kimi K3.1      ")
  assert.equal(cellWidth(instanceHead("kimi", "Kimi K3.1")), 30)
  // Does not fit: a 13-cell label clips to 12, then 5 pad + separator.
  assert.equal(instanceHead("grok471", "Grok 4.7.1"), " ├ Inspect… Go/Grok 4.7…      ")
  assert.equal(cellWidth(instanceHead("grok471", "Grok 4.7.1")), 30)
  // A.3's 13-cell text keeps the label whole and must fail.
  assert.notEqual(instanceHead("grok471", "Grok 4.7.1"), " ├ Inspect… Go/Grok 4.7.1     ")
  assert.equal(cellWidth(" ├ Inspect… Go/Grok 4.7.1     "), 30)
})

test("F21 above width 35 the instance text stays 12 cells and the column pads", () => {
  const at = (id: string, modelName: string) => {
    const agents = [agent("a", "A")]
    const sources: Sources = {
      sessions: fakeSessions(
        [
          { id: "root" },
          {
            id: "g",
            parentID: "root",
            agent: "a",
            title: "x",
            model: { id, providerID: "go" },
            time: { created: 100 },
          },
        ],
        ["g"],
      ),
      agents,
      models: [{ id, modelID: id, providerID: "go", name: modelName }],
      providers: [{ id: "go", name: "OpenCode Go" }],
      members: memberSet(agents),
    }
    return panel(sources, "root", 39, BODY_MAX_LINES, 0).rows[1].head
  }

  // Width 39: instance column 21, but the text cap stays 12, so the other 9
  // cells are padding and the separator precedes the boxes (F21, C13/C14).
  const head = at("kimi", "Kimi K3.1")
  assert.equal(head, " └ x        Go/Kimi K3.1          ")
  assert.equal(cellWidth(head), 39 - BAR_CELLS)
  assert.equal(head.length, 39 - BAR_CELLS)
  assert.equal(head.slice(12, 24), "Go/Kimi K3.1")
  assert.equal(head.slice(24, 33), " ".repeat(9))
  assert.equal(head.slice(33, 34), " ")
  assert.equal(cellWidth(head) + BAR_CELLS, 39)

  // Does not fit the 12-cell text cap: the 21-cell column has room, but the
  // text still clips at 12. A wider-text implementation (column-sized text)
  // would keep the 13-cell label whole.
  const long = at("grok471", "Grok 4.7.1")
  assert.equal(long.slice(12, 24), "Go/Grok 4.7…")
  assert.notEqual(long.slice(12, 24), "Go/Grok 4.7.1")
  assert.equal(cellWidth(long), 39 - BAR_CELLS)
  assert.equal(long.slice(24, 33), " ".repeat(9))
  assert.equal(cellWidth(long) + BAR_CELLS, 39)
})

test("C16 FILL_MIN_BOXES = 0 clamps the lower edge", () => {
  assert.equal(FILL_MIN_BOXES, 0)
  assert.equal(barFill(0), 0)
  assert.equal(barFill(4.99), 0)
  assert.equal(barFill(-1), 0)
})

test("C17 FILL_MAX_BOXES = 5 clamps the upper edge", () => {
  assert.equal(FILL_MAX_BOXES, 5)
  assert.equal(barFill(1000), 5)
  // Exclusive top floor: 100 exactly stays in the 4-box band.
  assert.equal(barFill(100), 4)
})

test("C18 FILL_BANDS = [5, 20, 50, 70, 100] fills one box at its lowest floor", () => {
  assert.deepEqual(FILL_BANDS, [5, 20, 50, 70, 100])
  assert.equal(barFill(4.99), 0)
  assert.equal(barFill(5), 1)
  assert.equal(barFill(20), 2)
  assert.equal(barFill(50), 3)
  assert.equal(barFill(70), 4)
  assert.equal(barFill(100), 4)
  assert.equal(barFill(100.01), 5)
})

test("C19 the fill formula counts the bands reached and clamps", () => {
  // Each inclusive floor reached exactly.
  assert.equal(barFill(5), 1)
  assert.equal(barFill(20), 2)
  assert.equal(barFill(50), 3)
  assert.equal(barFill(70), 4)
  // One hair below each inclusive floor keeps the previous band.
  assert.equal(barFill(4.99), 0)
  assert.equal(barFill(19.99), 1)
  assert.equal(barFill(49.99), 2)
  assert.equal(barFill(69.99), 3)
  // Exclusive top floor: strictly greater is required for the fifth box.
  assert.equal(barFill(100), 4)
  assert.equal(barFill(100.01), 5)
  assert.equal(barFill(1000), 5)
  // In-band values for the 5-19.9, 20-49.9 and 50-69.9 bands.
  assert.equal(barFill(19.9), 1)
  assert.equal(barFill(49.9), 2)
  assert.equal(barFill(69.9), 3)
  // Live sanity points from the R6 diagnostic (D1).
  assert.equal(barFill(5.59), 1)
  assert.equal(barFill(14.04), 1)
  assert.equal(barFill(undefined), 0)
})

test("fill stays inside the bar: 0 boxes at the low extreme, BAR_CELLS at the high", () => {
  assert.equal(barFill(0), 0)
  assert.equal(barFill(1000), BAR_CELLS)
})

test("C20 tps formula sums tokens over the summed stream window", () => {
  assert.equal(speedTps([assistant(200, 1000, 2000)]), 200)
  // 200 tokens over 4000 ms; the average of the per-message rates is 66.67.
  const two = [assistant(100, 0, 1000), assistant(100, 0, 3000)]
  assert.equal(speedTps(two), 50)
  assert.notEqual(speedTps(two), 66.67)

  // Does-not-fit: no completed time, no tokens, or a zero window.
  assert.equal(
    speedTps([{ type: "assistant", tokens: { output: 200 }, time: { created: 1000, streamed: 1000 } }]),
    undefined,
  )
  assert.equal(
    speedTps([{ type: "assistant", time: { created: 1000, streamed: 1000, completed: 2000 } }]),
    undefined,
  )
  assert.equal(speedTps([assistant(200, 1000, 1000)]), undefined)
  assert.equal(barFill(speedTps([assistant(200, 2000, 2000)])), 0)
})

test("C21 barTone is single green or muted", () => {
  assert.equal(barTone(barFill(5)), "success")
  assert.equal(barTone(barFill(300)), "success")
  // Five boxes never take a warning or error tone.
  assert.equal(barTone(barFill(1000)), "success")
  assert.equal(barTone(barFill(4.99)), "muted")
  assert.equal(barTone(barFill(undefined)), "muted")
  for (const filled of [0, 1, 2, 3, 4, 5]) {
    const tone = barTone(filled)
    assert.equal(tone === "success" || tone === "muted", true)
    assert.notEqual(tone, "warning")
    assert.notEqual(tone, "error")
  }
})

test("C30/C31 bar glyphs are the pinned pair, one cell each and flush", () => {
  const bar = (filled: number) =>
    BAR_GLYPH_FILLED.repeat(filled) + BAR_GLYPH_EMPTY.repeat(BAR_CELLS - filled)

  // Exact constants, not just the composed strings.
  assert.equal(BAR_GLYPH_FILLED, "▓")
  assert.equal(BAR_GLYPH_EMPTY, "░")
  assert.equal(cellWidth(BAR_GLYPH_FILLED), 1)
  assert.equal(cellWidth(BAR_GLYPH_EMPTY), 1)

  assert.equal(bar(5), "▓▓▓▓▓")
  assert.equal(bar(0), "░░░░░")
  assert.equal(bar(4), "▓▓▓▓░")
  assert.equal(cellWidth(bar(5)), BAR_CELLS)
  assert.equal(cellWidth(bar(0)), BAR_CELLS)
  assert.equal(cellWidth(bar(4)), BAR_CELLS)

  // The fits side: a run of zero glyphs is empty, no leftover literal.
  assert.equal(BAR_GLYPH_FILLED.repeat(0), "")
  assert.equal(BAR_GLYPH_EMPTY.repeat(0), "")

  // The retired pair (U+25AE/U+25AF) must not appear anywhere in the bar.
  assert.notEqual(BAR_GLYPH_FILLED, "▮")
  assert.notEqual(BAR_GLYPH_EMPTY, "▯")
  assert.equal(bar(5).includes("▮"), false)
  assert.equal(bar(0).includes("▯"), false)
})

test("C22 GRACE_MS = 30000 is a half-open window", () => {
  assert.equal(GRACE_MS, 30_000)
  const NOW = 1_000_000
  const graceAt = (elapsed: number) => {
    const session = child("f", "aa", NOW - elapsed, {
      outcome: "failed",
      time: { created: NOW - elapsed, updated: NOW - elapsed },
    })
    return panel(rootSources([session], [agent("aa", "Alpha")]), "root", 35, BODY_MAX_LINES, NOW)
  }

  const inside = graceAt(29_999)
  assert.equal(inside.rows[1].state, "grace")
  assert.equal(inside.rows[0].state, "grace")

  const folded = graceAt(30_000)
  assert.equal(folded.rows.some((row) => row.state === "grace"), false)
  assert.equal(folded.rows.length, 1)
  assert.equal(folded.rows[0].state, "idle")
})

test("C23 GRACE_TICK_MS = 1000 moves a grace row past the boundary", () => {
  assert.equal(GRACE_TICK_MS, 1_000)
  const session = child("f", "aa", 0, {
    outcome: "failed",
    time: { created: 0, updated: 0 },
  })
  const sources = rootSources([session], [agent("aa", "Alpha")])

  const before = panel(sources, "root", 35, BODY_MAX_LINES, GRACE_MS - GRACE_TICK_MS)
  assert.equal(before.rows[1].state, "grace")

  const after = panel(sources, "root", 35, BODY_MAX_LINES, GRACE_MS - GRACE_TICK_MS + GRACE_TICK_MS)
  assert.equal(after.rows.some((row) => row.state === "grace"), false)
})

test("C24 PICKER_MODEL_CELLS = 96 clips the picker model label", () => {
  assert.equal(PICKER_MODEL_CELLS, 96)
  const label = "a".repeat(96)
  assert.equal(clip(label, PICKER_MODEL_CELLS), label)
  assert.equal(clip(`${label}a`, PICKER_MODEL_CELLS), `${"a".repeat(95)}…`)
})

test("C25 ELLIPSIS_CELLS = 1 is reserved by every clip", () => {
  assert.equal(ELLIPSIS_CELLS, 1)
  assert.equal(clip("abc", 5), "abc")
  assert.equal(clip("abcdef", 4), "abc…")
  assert.equal(clip("abc", 1), "…")
  assert.equal(clip("abc", 0), "")
})

test("C26 PROVIDER_MAX_SHARE = 1/2 caps the provider side", () => {
  assert.equal(PROVIDER_MAX_SHARE, 1 / 2)
  // Budget 15: provider `Go` (2 cells) fits inside the 6-cell provider text cap.
  assert.equal(fitModel("Go/Kimi K3.1 Pro", 15), "Go/Kimi K3.1 P…")
  // Provider text 6 cells + `/` = 7 = floor(15 / 2).
  assert.equal(fitModel("SomeVeryBigName/Model", 15), "SomeV…/Model")
})

test("C27 UNKNOWN_MODEL is the last resolution fallback", () => {
  assert.equal(UNKNOWN_MODEL, "unknown model")
  const sources: Sources = { sessions: fakeSessions([{ id: "s1" }]) }
  assert.equal(resolveModel(sources.sessions.list()[0], sources), "unknown model")

  // A known snapshot baseline keeps the unknown instance label visible (A.10);
  // the live definition carries no model, so R8 falls through to `unknown model`.
  const knownRole = agent("aa", "Alpha", {
    model: { id: "deepseek-flash", providerID: "deepseek" },
  })
  const liveRole = agent("aa", "Alpha")
  const unknown = (width: number) =>
    panel(
      {
        sessions: fakeSessions([{ id: "root" }, child("u", "aa", 100)], ["u"]),
        agents: [liveRole],
        models,
        providers,
        members: memberSet([knownRole]),
      },
      "root",
      width,
      BODY_MAX_LINES,
      0,
    )
  // Width 30 leaves a 12-cell instance column: the 13-cell text clips.
  assert.equal(unknown(30).rows[1].head.slice(12, 24), "unknown mod…")
  // Width 29 leaves an 11-cell column, so the column binds.
  assert.equal(unknown(29).rows[1].head.slice(12, 23), "unknown mo…")
  // Width 39 leaves a 21-cell column, but the text cap stays 12.
  assert.equal(unknown(39).rows[1].head.slice(12, 24), "unknown mod…")
  assert.notEqual(unknown(39).rows[1].head.slice(12, 24), UNKNOWN_MODEL)
  assert.equal(clip(UNKNOWN_MODEL, 13), "unknown model")
  assert.equal(clip(UNKNOWN_MODEL, 12), "unknown mod…")
})

test("C28 PICKER_AGENT_CELLS = 24 clips the agent on its own budget", () => {
  assert.equal(PICKER_AGENT_CELLS, 24)
  assert.equal(clip("explore-deep-review-qa", PICKER_AGENT_CELLS), "explore-deep-review-qa")
  assert.equal(clip("explore-deep-review-qa12", PICKER_AGENT_CELLS), "explore-deep-review-qa12")
  assert.equal(clip("explore-deep-review-qa123", PICKER_AGENT_CELLS), "explore-deep-review-qa1…")
  assert.equal(pickerTitle("explore-deep-review-qa123", "m"), "explore-deep-review-qa1… · m")
})

test("C29 picker agent and model budgets are independent", () => {
  const model = "m".repeat(PICKER_MODEL_CELLS)

  const fits = pickerTitle("explore-deep-review-qa12", model)
  assert.equal(fits, `explore-deep-review-qa12 · ${model}`)
  assert.equal(cellWidth(fits.split(" · ")[1]), PICKER_MODEL_CELLS)

  // 25-cell agent: 24 cells + ellipsis, and the model keeps its full 96 cells (not 95).
  const clipped = pickerTitle("explore-deep-review-qa123", model)
  assert.equal(clipped, `explore-deep-review-qa1… · ${model}`)
  assert.equal(clipped.split(" · ")[1], model)
  assert.equal(cellWidth(clipped.split(" · ")[1]), PICKER_MODEL_CELLS)
})

test("R6 unknown speed keeps both rows' boxes empty", () => {
  const NOW = 1_000_000
  const sources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root" },
        child("a-1", "aa", NOW, { model: { id: "deepseek-flash", providerID: "deepseek" } }),
      ],
      ["a-1"],
      { "a-1": [{ type: "assistant", tokens: { output: 1_000 } }] },
    ),
    agents: [agent("aa", "Alpha")],
    models,
    providers,
    members: memberSet([agent("aa", "Alpha")]),
  }

  const view = panel(sources, "root", 35, BODY_MAX_LINES, NOW)
  assert.equal(view.rows[0].tps, undefined)
  assert.equal(view.rows[0].filled, 0)
  assert.equal(view.rows[1].tps, undefined)
  assert.equal(view.rows[1].filled, 0)
  assert.equal(barTone(view.rows[0].filled), "muted")
})

test("role row carries the busiest active instance tps and fill (G13)", () => {
  const NOW = 1_000_000
  const sessions = [child("a-1", "aa", NOW), child("a-2", "aa", NOW + 1)]
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }, ...sessions], ["a-1", "a-2"], {
      "a-1": [assistant(20, 0, 1000)],
      "a-2": [assistant(60, 0, 1000)],
    }),
    agents: [agent("aa", "Alpha", { model: { id: "deepseek-flash", providerID: "deepseek" } })],
    models,
    providers,
    members: memberSet([
      agent("aa", "Alpha", { model: { id: "deepseek-flash", providerID: "deepseek" } }),
    ]),
  }

  const view = panel(sources, "root", 35, BODY_MAX_LINES, NOW)
  assert.equal(view.rows[0].tps, 60)
  assert.equal(view.rows[0].filled, 3)
  assert.equal(view.rows[1].tps, 20)
  assert.equal(view.rows[1].filled, 2)
  assert.equal(view.rows[2].tps, 60)
  assert.equal(view.rows[2].filled, 3)
})

test("role row keeps the known tps when the other instance is unknown (G13)", () => {
  const NOW = 1_000_000
  const sessions = [child("a-1", "aa", NOW), child("a-2", "aa", NOW + 1)]
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }, ...sessions], ["a-1", "a-2"], {
      "a-2": [assistant(40, 0, 1000)],
    }),
    agents: [agent("aa", "Alpha", { model: { id: "deepseek-flash", providerID: "deepseek" } })],
    models,
    providers,
    members: memberSet([
      agent("aa", "Alpha", { model: { id: "deepseek-flash", providerID: "deepseek" } }),
    ]),
  }

  const view = panel(sources, "root", 35, BODY_MAX_LINES, NOW)
  assert.equal(view.rows[0].tps, 40)
  assert.equal(view.rows[0].filled, 2)
  assert.equal(view.rows[1].tps, undefined)
  assert.equal(view.rows[1].filled, 0)
  assert.equal(view.rows[2].tps, 40)
  assert.equal(view.rows[2].filled, 2)
})

test("F18 a grace instance and its role show empty boxes", () => {
  const NOW = 1_000_000
  const session = child("g", "aa", NOW - 1_000, {
    outcome: "failed",
    time: { created: NOW - 1_000, updated: NOW - 1_000 },
  })
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }, session], [], {
      g: [assistant(200, 0, 1000)],
    }),
    agents: [agent("aa", "Alpha")],
    models,
    providers,
    members: memberSet([agent("aa", "Alpha")]),
  }

  const view = panel(sources, "root", 35, BODY_MAX_LINES, NOW)
  assert.equal(view.rows[0].state, "grace")
  assert.equal(view.rows[0].tps, undefined)
  assert.equal(view.rows[0].filled, 0)
  assert.equal(view.rows[1].state, "grace")
  assert.equal(view.rows[1].tps, undefined)
  assert.equal(view.rows[1].filled, 0)
})

test("F22 speed never reads now and an in-flight message never counts", () => {
  const session = child("a-1", "aa", 0)
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }, session], ["a-1"], {
      "a-1": [assistant(60, 0, 1000)],
    }),
    agents: [agent("aa", "Alpha")],
    models,
    providers,
    members: memberSet([agent("aa", "Alpha")]),
  }

  const early = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  const late = panel(sources, "root", 35, BODY_MAX_LINES, 9_999_999)
  assert.equal(early.rows[1].tps, 60)
  assert.equal(late.rows[1].tps, 60)
  assert.equal(early.rows[1].filled, late.rows[1].filled)

  const incomplete: Sources = {
    sessions: fakeSessions([{ id: "root" }, session], ["a-1"], {
      "a-1": [{ type: "assistant", tokens: { output: 500 }, time: { created: 0, streamed: 0 } }],
    }),
    agents: [agent("aa", "Alpha")],
    models,
    providers,
    members: memberSet([agent("aa", "Alpha")]),
  }
  const view = panel(incomplete, "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[1].tps, undefined)
  assert.equal(view.rows[1].filled, 0)
})

/* ------------------------------------------------------------------ */
/* §4 orderings and overflow stop-rule fixtures.                       */
/* ------------------------------------------------------------------ */

test("stop rule: a non-fitting section blocks every later section", () => {
  const a = runningRole("aa", "A", 7, 100)
  const b = runningRole("bb", "B", 2, 200)
  const c = agent("cc", "C")
  const view = panel(
    rootSources([...a.sessions, ...b.sessions], [a.agent, b.agent, c], [...a.running, ...b.running]),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.rows.length, 8)
  assert.equal(view.more, 4)
  assert.equal(view.rows[0].head.startsWith(" 1.A"), true)
  assert.equal(view.rows.some((row) => /^ \d+\.(B|C) /.test(row.head)), false)
  assert.equal(view.working, 2)
  assert.equal(view.total, 3)
})

test("stop rule: a fitting body stops nothing", () => {
  const a = runningRole("aa", "A", 7, 100)
  const roles = [agent("x", "RoleX"), agent("y", "RoleY")]
  const view = panel(
    rootSources(a.sessions, [a.agent, ...roles], a.running),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.rows.length, 10)
  assert.equal(view.more, 0)
})

test("stop rule: a single oversized section folds whole", () => {
  const a = runningRole("aa", "A", 10, 100)
  const view = panel(
    rootSources(a.sessions, [a.agent, agent("b", "B")], a.running),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.rows.length, 0)
  assert.equal(view.more, 12)
})

test("stop rule: five instances leave room for four idle roles", () => {
  const a = runningRole("aa", "A", 5, 100)
  const idle = Array.from({ length: 10 }, (_, index) => agent(`i${index}`, `Idle${index}`))
  const view = panel(
    rootSources(a.sessions, [a.agent, ...idle], a.running),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.rows.length, 10)
  assert.equal(view.more, 6)
})

/* ------------------------------------------------------------------ */
/* Additional exact-value fixtures that carry no number.               */
/* ------------------------------------------------------------------ */

test("role row at width 35 fills the model column exactly", () => {
  const agents = [agent("coder", "coder", { model: { id: "kimi", providerID: "go" } })]
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }]),
    agents,
    models: [{ id: "kimi", modelID: "kimi", providerID: "go", name: "Kimi K3.1 Pro" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
    members: memberSet(agents),
  }
  const head = panel(sources, undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(head, " 1.coder     Go/Kimi K3.1 Pro ")
  assert.equal(cellWidth(head), 30)
})

test("instance row at width 35 pads the model column", () => {
  const agents = [agent("a", "A")]
  const sources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root" },
        {
          id: "grok",
          parentID: "root",
          agent: "a",
          title: "Inspect modules",
          model: { id: "grok47", providerID: "go" },
          time: { created: 100 },
        },
        {
          id: "later",
          parentID: "root",
          agent: "a",
          title: "second",
          model: { id: "grok47", providerID: "go" },
          time: { created: 200 },
        },
      ],
      ["grok", "later"],
    ),
    agents,
    models: [{ id: "grok47", modelID: "grok47", providerID: "go", name: "Grok 4.7" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
    members: memberSet(agents),
  }
  const head = panel(sources, "root", 35, BODY_MAX_LINES, 0).rows[1].head
  assert.equal(head, " ├ Inspect… Go/Grok 4.7       ")
  assert.equal(cellWidth(head), 30)
})

test("speed bar follows the separator at width 35 (filled = 3)", () => {
  const NOW = 1_000_000
  const agents = [agent("explore", "explore", { model: { id: "kimi", providerID: "go" } })]
  const sources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root" },
        { id: "i", parentID: "root", agent: "explore", title: "x", time: { created: NOW } },
      ],
      ["i"],
      { i: [assistant(50, 0, 1_000)] },
    ),
    agents,
    models: [{ id: "kimi", modelID: "kimi", providerID: "go", name: "Kimi K3.1 Pro" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
    members: memberSet(agents),
  }
  const bar = (filled: number) =>
    BAR_GLYPH_FILLED.repeat(filled) + BAR_GLYPH_EMPTY.repeat(BAR_CELLS - filled)

  const role = panel(sources, "root", 35, BODY_MAX_LINES, NOW).rows[0]
  assert.equal(role.filled, 3)
  // A.9: the built-in role row carries the tag; the bar is untouched.
  assert.equal(role.head + bar(role.filled), " 1.explore   [built-in]       ▓▓▓░░")
  assert.equal(cellWidth(role.head + bar(role.filled)), 35)
})

test("title counts and compact count follow the view", () => {
  const running = runningRole("aa", "Alpha", 1, 100)
  const idle = [agent("b", "Beta"), agent("c", "Gamma"), agent("d", "Delta"), agent("e", "Epsilon")]
  const sources = rootSources(running.sessions, [running.agent, ...idle], running.running)
  const view = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.working, 1)
  assert.equal(view.total, 5)

  const three = runningRole("aa", "Alpha", 3, 100)
  assert.equal(collect(rootSources(three.sessions, [three.agent], three.running), "root").length, 3)

  // Two different fields: title N = roles with a working instance, compact N =
  // running subagents in scope. Two running children -> 1 and 2.
  const pair = runningRole("aa", "Alpha", 2, 100)
  const pairSources = rootSources(pair.sessions, [pair.agent], pair.running)
  assert.equal(panel(pairSources, "root", 35, BODY_MAX_LINES, 0).working, 1)
  assert.equal(collect(pairSources, "root").length, 2)

  // A non-member runner syncs for the compact count but cannot enter the title.
  const members = memberSet([agent("coder", "coder")])
  const helper = child("h-1", "helper", 1_000)
  const runnerSources = rootSources(
    [helper],
    [agent("coder", "coder"), agent("helper", "helper")],
    ["h-1"],
    {},
    members,
  )
  const runnerView = panel(runnerSources, "root", 35, BODY_MAX_LINES, 0)
  assert.equal(runnerView.working, 0)
  assert.equal(runnerView.total, 1)
  assert.equal(collect(runnerSources, "root").length, 1)
})

test("ordering: oldest instance first between and inside roles", () => {
  const late = runningRole("late", "Late", 1, 20)
  const early = runningRole("early", "Early", 1, 10)
  const between = panel(
    rootSources([...late.sessions, ...early.sessions], [late.agent, early.agent], [...late.running, ...early.running]),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(between.rows[0].head.startsWith(" 1.Early"), true)
  assert.equal(between.rows[2].head.startsWith(" 2.Late"), true)

  const role = runningRole("aa", "Alpha", 1, 30)
  const second = child("second", "aa", 10)
  const inside = panel(
    rootSources([...role.sessions, second], [role.agent], [...role.running, "second"]),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(inside.rows[1].head.startsWith(" ├ second"), true)
  assert.equal(inside.rows[2].head.startsWith(" └ aa-0"), true)

  const idle = panel(
    rootSources([], [agent("z", "Zeta"), agent("a", "alpha")]),
    undefined,
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(idle.rows[0].head.startsWith(" 1.alpha"), true)
  assert.equal(idle.rows[1].head.startsWith(" 2.Zeta"), true)
})

test("isVisibleRole excludes hidden and primary agents only (R2)", () => {
  assert.equal(isVisibleRole({ id: "sub", mode: "subagent" }), true)
  assert.equal(isVisibleRole({ id: "unset" }), true)
  assert.equal(isVisibleRole({ id: "all", mode: "all" }), true)
  assert.equal(isVisibleRole({ id: "hidden", hidden: true }), false)
  assert.equal(isVisibleRole({ id: "lead", mode: "primary" }), false)
  assert.equal(isVisibleRole({ id: "hidden-lead", mode: "primary", hidden: true }), false)
})

/* ------------------------------------------------------------------ */
/* A.8 member-selection scenarios S1-S12, exact values.                */
/* ------------------------------------------------------------------ */

const CHARTER_LIST = [
  agent("build", "build", { mode: "primary" }),
  agent("general", "general"),
  agent("explore", "explore"),
  agent("coder", "coder"),
  agent("designer", "designer"),
]

/** A role row with a blank model column at width 35: number, name, gap, 16, separator. */
function blankRoleHead(number: number, name: string): string {
  const padding = ROLE_NAME_CELLS - name.length
  return `${String(number).padStart(ROLE_NUMBER_DIGITS)}.${name}${" ".repeat(padding + 1 + 16 + 1)}`
}

/** A built-in role row at width 35: number, name, gap, tag, 6 pad, separator (C33, C34). */
function tagRoleHead(number: number, name: string): string {
  const column = DEFAULT_WIDTH - ROLE_FIXED_CELLS
  const tag = clip(BUILTIN_TAG_TEXT, column)
  const padding = ROLE_NAME_CELLS - name.length
  return `${String(number).padStart(ROLE_NUMBER_DIGITS)}.${name}${" ".repeat(padding + 1)}${tag}${" ".repeat(column - cellWidth(tag) + 1)}`
}

test("C32 BUILTIN_AGENT_IDS is the host builtin registry", () => {
  assert.deepEqual(BUILTIN_AGENT_IDS, [
    "build",
    "compaction",
    "explore",
    "general",
    "summary",
    "title",
  ])
  // Fits: one id outside the set selects charter mode.
  assert.equal(memberSet([agent("general", "general"), agent("coder", "coder")]).mode, "charter")
  // Does not fit: every id is builtin, so built-in mode is selected.
  assert.equal(memberSet([agent("general", "general"), agent("title", "title")]).mode, "builtin")
})

test("S1 charter snapshot keeps M and member rows stable", () => {
  const snapshot = memberSet(CHARTER_LIST)
  assert.equal(snapshot.mode, "charter")
  assert.deepEqual(
    snapshot.roles.map((role) => role.id),
    ["coder", "designer"],
  )

  const view = panel(
    rootSources([], CHARTER_LIST, [], {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(view.mode, "charter")
  assert.equal(view.working, 0)
  assert.equal(view.total, 2)
  assert.equal(view.more, 0)
  assert.equal(view.rows.length, 2)
  // Idle rows are alphabetical by display name.
  assert.equal(view.rows[0].head, blankRoleHead(1, "coder"))
  assert.equal(view.rows[1].head, blankRoleHead(2, "designer"))

  // A helper definition and a running helper appear: no helper row, M stays 2.
  const laterAgents = [...CHARTER_LIST, agent("helper", "helper")]
  const helperRun = child("h-1", "helper", 1_000)
  const later = panel(
    rootSources([helperRun], laterAgents, ["h-1"], {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(later.total, 2)
  assert.equal(later.working, 0)
  assert.equal(later.rows.some((row) => row.head.includes("helper")), false)

  // coder disappears from the live list: the snapshot definition keeps its row.
  const deleted = CHARTER_LIST.filter((entry) => entry.id !== "coder")
  const afterDelete = panel(
    rootSources([], deleted, [], {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(afterDelete.total, 2)
  assert.equal(afterDelete.rows[0].head, blankRoleHead(1, "coder"))
  assert.equal(afterDelete.rows[1].head, blankRoleHead(2, "designer"))
})

test("S2 built-in mode lists visible builtins only", () => {
  const agents = [
    agent("build", "build", { mode: "primary" }),
    agent("general", "general"),
    agent("explore", "explore"),
    agent("title", "title", { mode: "primary", hidden: true }),
    agent("summary", "summary", { mode: "primary", hidden: true }),
    agent("compaction", "compaction", { mode: "primary", hidden: true }),
  ]
  const snapshot = memberSet(agents)
  assert.equal(snapshot.mode, "builtin")
  assert.deepEqual(snapshot.roles.map((role) => role.id).sort(), ["explore", "general"])

  const view = panel(rootSources([], agents, [], {}, snapshot), undefined, 35, BODY_MAX_LINES, 0)
  assert.equal(view.mode, "builtin")
  assert.equal(view.total, 2)
  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].head, tagRoleHead(1, "explore"))
  assert.equal(view.rows[1].head, tagRoleHead(2, "general"))
})

test("S3 charter mode suppresses builtin idle rows", () => {
  const agents = [agent("general", "general"), agent("explore", "explore"), agent("coder", "coder")]
  const snapshot = memberSet(agents)
  assert.equal(snapshot.mode, "charter")
  assert.deepEqual(snapshot.roles.map((role) => role.id), ["coder"])

  const view = panel(rootSources([], agents, [], {}, snapshot), undefined, 35, BODY_MAX_LINES, 0)
  assert.equal(view.working, 0)
  assert.equal(view.total, 1)
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].head, blankRoleHead(1, "coder"))
})

test("S4 temporary builtin and member both work gives 2/1", () => {
  const agents = [agent("general", "general"), agent("explore", "explore"), agent("coder", "coder")]
  const snapshot = memberSet(agents)
  const audit = child("a-1", "general", 1_000, { title: "Audit" })
  const check = child("c-1", "coder", 2_000, { title: "Check" })
  const view = panel(
    rootSources([audit, check], agents, ["a-1", "c-1"], {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.mode, "charter")
  assert.equal(view.working, 2)
  assert.equal(view.total, 1)
  assert.equal(`${view.working}/${view.total}`, "2/1")
  assert.equal(view.rows.length, 4)
  assert.equal(view.rows[0].head, tagRoleHead(1, "general"))
  assert.equal(view.rows[0].state, "active")
  // 8-cell title field pads without an ellipsis when it fits.
  // A.10: both sides are unknown, so the model cell is omitted (C35, F29).
  assert.equal(view.rows[1].head, " └ Audit" + " ".repeat(22))
  assert.equal(view.rows[1].head.slice(3, 11), "Audit   ")
  assert.equal(view.rows[2].head, blankRoleHead(2, "coder"))
  assert.equal(view.rows[3].head, " └ Check" + " ".repeat(22))
  assert.equal(view.rows[3].head.slice(3, 11), "Check   ")
})

test("R8 a temporary builtin resolves its live definition model", () => {
  const general = agent("general", "general", {
    model: { id: "deepseek-flash", providerID: "deepseek" },
  })
  const members = memberSet([general, agent("coder", "coder")])
  const audit = child("a-1", "general", 1_000, { title: "Audit" })
  const view = panel(rootSources([audit], [general, agent("coder", "coder")], ["a-1"], {}, members), "root", 35, BODY_MAX_LINES, 0)

  assert.equal(view.total, 1)
  // A.9: the built-in role row carries the tag even when the live definition
  // resolves a model. A.10: the instance resolves the same live definition
  // model, so its label is equal to the baseline and the cell is omitted.
  assert.equal(view.rows[0].head, tagRoleHead(1, "general"))
  assert.equal(view.rows[1].head, " └ Audit" + " ".repeat(22))
})

test("S5 a succeeded temporary last instance removes both rows", () => {
  const agents = [agent("general", "general"), agent("explore", "explore"), agent("coder", "coder")]
  const snapshot = memberSet(agents)
  const succeeded = child("a-1", "general", 1_000, {
    title: "Audit",
    outcome: "succeeded",
    time: { created: 1_000, updated: 2_000 },
  })
  const view = panel(
    rootSources([succeeded], agents, [], {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.working, 0)
  assert.equal(view.total, 1)
  assert.equal(`${view.working}/${view.total}`, "0/1")
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].head, blankRoleHead(1, "coder"))
  assert.equal(view.rows[0].state, "idle")
})

test("S6 a failed temporary keeps both rows for exactly 30 s", () => {
  const agents = [agent("general", "general"), agent("explore", "explore"), agent("coder", "coder")]
  const snapshot = memberSet(agents)
  const ended = 100_000
  const failed = child("a-1", "general", 1_000, {
    title: "Audit",
    outcome: "failed",
    time: { created: 1_000, updated: ended },
  })

  const inside = panel(
    rootSources([failed], agents, [], {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    ended + 29_999,
  )
  assert.equal(inside.working, 0)
  assert.equal(inside.total, 1)
  assert.equal(`${inside.working}/${inside.total}`, "0/1")
  assert.equal(inside.rows.length, 3)
  assert.equal(inside.rows[0].head, tagRoleHead(1, "general"))
  assert.equal(inside.rows[0].state, "grace")
  // A.10: role and instance are both unknown, so the model cell is omitted.
  assert.equal(inside.rows[1].head, " └ Audit" + " ".repeat(22))
  assert.equal(inside.rows[1].state, "grace")
  assert.equal(inside.rows[2].head, blankRoleHead(2, "coder"))
  assert.equal(inside.rows[2].state, "idle")

  const boundary = panel(
    rootSources([failed], agents, [], {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    ended + 30_000,
  )
  assert.equal(boundary.working, 0)
  assert.equal(boundary.total, 1)
  assert.equal(`${boundary.working}/${boundary.total}`, "0/1")
  assert.equal(boundary.rows.length, 1)
  assert.equal(boundary.rows[0].head, blankRoleHead(1, "coder"))
})

test("S7 several temporary rows order with a member by instance start", () => {
  const agents = [agent("general", "general"), agent("explore", "explore"), agent("coder", "coder")]
  const snapshot = memberSet(agents)
  const sessions = [
    child("e-1", "explore", 1_000),
    child("g-1", "general", 2_000),
    child("c-1", "coder", 3_000),
  ]
  const view = panel(
    rootSources(sessions, agents, sessions.map((session) => session.id), {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.working, 3)
  assert.equal(view.total, 1)
  assert.equal(`${view.working}/${view.total}`, "3/1")
  assert.equal(view.rows[0].head, tagRoleHead(1, "explore"))
  assert.equal(view.rows[2].head, tagRoleHead(2, "general"))
  assert.equal(view.rows[4].head, blankRoleHead(3, "coder"))
})

test("S8 a non-member custom runner stays invisible", () => {
  const members = memberSet([agent("general", "general"), agent("coder", "coder")])
  const live = [agent("general", "general"), agent("coder", "coder"), agent("helper", "helper")]
  const helper = child("h-1", "helper", 1_000)
  const view = panel(rootSources([helper], live, ["h-1"], {}, members), "root", 35, BODY_MAX_LINES, 0)

  assert.equal(view.working, 0)
  assert.equal(view.total, 1)
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].head, blankRoleHead(1, "coder"))
  assert.equal(view.rows.some((row) => row.head.includes("helper")), false)
})

test("S9 built-in mode ignores a custom runner", () => {
  const members = memberSet([agent("general", "general"), agent("explore", "explore")])
  const live = [agent("general", "general"), agent("explore", "explore"), agent("coder", "coder")]
  const coder = child("c-1", "coder", 1_000)
  const view = panel(rootSources([coder], live, ["c-1"], {}, members), "root", 35, BODY_MAX_LINES, 0)

  assert.equal(view.mode, "builtin")
  assert.equal(view.total, 2)
  assert.equal(view.working, 0)
  assert.equal(view.rows.length, 2)
  assert.equal(view.rows.some((row) => row.head.includes("coder")), false)
})

test("S10 a temporary section folds whole and keeps M", () => {
  const a = runningRole("a", "A", 7, 100)
  const general = runningRole("general", "general", 2, 200)
  const b = agent("b", "B")
  const members = memberSet([general.agent, a.agent, b])
  const view = panel(
    rootSources([...a.sessions, ...general.sessions], [general.agent, a.agent, b], [...a.running, ...general.running], {}, members),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.total, 2)
  assert.equal(view.working, 2)
  assert.equal(view.rows.length, 8)
  assert.equal(view.more, 4)
  assert.equal(view.rows.some((row) => row.head.includes("general")), false)
  assert.equal(view.rows.some((row) => row.head.includes("B")), false)
})

test("S11 C32 boundary and the total = 0 guard", () => {
  const builtin = memberSet([agent("general", "general")])
  assert.equal(builtin.mode, "builtin")
  assert.deepEqual(builtin.roles.map((role) => role.id), ["general"])
  assert.equal(builtin.roles.length, 1)

  const charter = memberSet([agent("general", "general"), agent("coder", "coder")])
  assert.equal(charter.mode, "charter")
  assert.deepEqual(charter.roles.map((role) => role.id), ["coder"])
  assert.equal(charter.roles.length, 1)

  const titleOnly = memberSet([agent("title", "title", { mode: "primary", hidden: true })])
  assert.equal(titleOnly.mode, "builtin")
  assert.deepEqual(titleOnly.roles, [])

  const primaryOnly = memberSet([agent("general", "general"), agent("helper", "helper", { mode: "primary" })])
  assert.equal(primaryOnly.mode, "charter")
  assert.deepEqual(primaryOnly.roles, [])

  const running = child("g-1", "general", 1_000)
  const hidden = panel(
    rootSources([running], [agent("general", "general")], ["g-1"], {}, primaryOnly),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(hidden.total, 0)
  // The pure layer still emits the temporary section; the F27 hide gate is
  // `total > 0`, so a total of 0 renders nothing (docs/design.md §3, F27).
  assert.equal(hidden.working, 1)
  assert.equal(hidden.rows.length, 2)
  assert.equal(hidden.rows[0].head, tagRoleHead(1, "general"))
  assert.equal(hidden.rows[0].state, "active")
  // A.10: both sides are unknown, so the model cell is omitted.
  assert.equal(hidden.rows[1].head, " └ g-1" + " ".repeat(24))
  assert.equal(hidden.rows[1].state, "active")
  assert.equal(hidden.total > 0, false)
})

test("a missing member snapshot yields total = 0 and no rows", () => {
  const view = panel(
    { sessions: fakeSessions([{ id: "root" }]), agents: [agent("coder", "coder")] },
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(view.mode, "builtin")
  assert.equal(view.total, 0)
  assert.equal(view.working, 0)
  assert.deepEqual(view.rows, [])
})

test("an empty agent list locks built-in mode with no members", () => {
  // Pinned shortcut: a transient empty list is cached as builtin mode.
  const empty = memberSet([])
  assert.deepEqual(empty, { mode: "builtin", roles: [] })

  const general = agent("general", "general")
  const running = child("g-1", "general", 1_000)
  const view = panel(rootSources([running], [general], ["g-1"], {}, empty), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.mode, "builtin")
  assert.equal(view.total, 0)
  assert.equal(view.working, 0)
  assert.deepEqual(view.rows, [])

  // Built-in mode with a loaded builtin list does list its idle row.
  const loaded = memberSet([general])
  assert.deepEqual(loaded, { mode: "builtin", roles: [general] })
  const idle = panel(rootSources([], [general], [], {}, loaded), undefined, 35, BODY_MAX_LINES, 0)
  assert.equal(idle.total, 1)
  assert.equal(idle.rows.length, 1)
  assert.equal(idle.rows[0].head, tagRoleHead(1, "general"))
})

test("S12 the snapshot is frozen; the next activation re-decides", () => {
  const snapshot = memberSet([agent("general", "general"), agent("coder", "coder")])
  assert.equal(snapshot.mode, "charter")
  assert.deepEqual(snapshot.roles.map((role) => role.id), ["coder"])

  const live = [agent("general", "general"), agent("designer", "designer")]
  const general = child("g-1", "general", 1_000)
  const designer = child("d-1", "designer", 2_000)
  const frozen = panel(
    rootSources([general, designer], live, ["g-1", "d-1"], {}, snapshot),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(frozen.mode, "charter")
  assert.equal(frozen.total, 1)
  assert.equal(frozen.working, 1)
  assert.equal(frozen.rows[0].head, tagRoleHead(1, "general"))
  assert.equal(frozen.rows[2].head, blankRoleHead(2, "coder"))
  assert.equal(frozen.rows.some((row) => row.head.includes("designer")), false)

  const next = memberSet(live)
  assert.equal(next.mode, "charter")
  assert.deepEqual(next.roles.map((role) => role.id), ["designer"])
  assert.equal(next.roles.length, 1)
})

test("F28 an out-of-scope builtin instance cannot materialise a temporary row", () => {
  const members = memberSet([agent("general", "general"), agent("coder", "coder")])
  const elsewhere = child("g-1", "general", 1_000, { parentID: "other-root" })
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }, { id: "other-root" }, elsewhere], ["g-1"]),
    agents: [agent("general", "general"), agent("coder", "coder")],
    models,
    providers,
    members,
  }
  const view = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.working, 0)
  assert.equal(view.total, 1)
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].head, blankRoleHead(1, "coder"))
})

test("G20 the picker predicate still sees a running temporary builtin", () => {
  const members = memberSet([agent("general", "general"), agent("coder", "coder")])
  const general = child("g-1", "general", 1_000)
  const sources = rootSources([general], [agent("general", "general"), agent("coder", "coder")], ["g-1"], {}, members)
  assert.deepEqual(
    collect(sources, "root").map((row) => row.sessionID),
    ["g-1"],
  )
})

/* ------------------------------------------------------------------ */
/* A.9 built-in tag: C33/C34 and scenarios T1-T5, exact values.        */
/* ------------------------------------------------------------------ */

const GO_MODELS = [
  { id: "kimi", modelID: "kimi", providerID: "go", name: "Kimi K3.1 Pro" },
  { id: "grok47", modelID: "grok47", providerID: "go", name: "Grok 4.7" },
  { id: "kimi-max", modelID: "kimi-max", providerID: "go", name: "Kimi K3.1 Pro Max" },
  { id: "kimi-maxx", modelID: "kimi-maxx", providerID: "go", name: "Kimi K3.1 Pro Maxx" },
]
const GO_PROVIDERS = [{ id: "go", name: "OpenCode Go" }]

/** A panel source with the `Go/*` model catalog used by the A.9 fixtures. */
function goSources(
  sessions: SessionInfo[],
  agents: AgentInfo[],
  running: string[] = [],
  members: MemberSet = memberSet(agents),
): Sources {
  return {
    sessions: fakeSessions([{ id: "root" }, ...sessions], running),
    agents,
    models: GO_MODELS,
    providers: GO_PROVIDERS,
    members,
  }
}

test("C33 BUILTIN_TAG_TEXT = '[built-in]' clips by the ordinary rule", () => {
  assert.equal(BUILTIN_TAG_TEXT, "[built-in]")
  assert.equal(cellWidth(BUILTIN_TAG_TEXT), 10)
  assert.equal(clip(BUILTIN_TAG_TEXT, 10), "[built-in]")
  assert.equal(clip(BUILTIN_TAG_TEXT, 9), "[built-i…")
  assert.equal(clip(BUILTIN_TAG_TEXT, 1), "…")
  assert.equal(clip(BUILTIN_TAG_TEXT, 0), "")

  const headAt = (width: number) =>
    panel(rootSources([], [agent("explore", "explore")]), undefined, width, BODY_MAX_LINES, 0)
      .rows[0].head

  // Fits at the 10-cell column and above; the tag plus pad fills the column.
  assert.equal(headAt(35), " 1.explore   [built-in]       ")
  assert.equal(headAt(29), " 1.explore   [built-in] ")
  // Does not fit: the column clips the tag, and at the floor it vanishes.
  assert.equal(headAt(28), " 1.explore   [built-i… ")
  assert.equal(headAt(20), " 1.explore   … ")
  assert.equal(headAt(19), " 1.explore    ")
})

test("C34 built-in slot holds the tag; member and instance rows keep the model", () => {
  // Built-in role: the tag fills the model column and the bar is unchanged.
  const explore = agent("explore", "explore", { model: { id: "kimi", providerID: "go" } })
  const run = child("e-1", "explore", 1_000, {
    title: "Inspect modules",
    model: { id: "grok47", providerID: "go" },
  })
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }, run], ["e-1"], {
      "e-1": [assistant(50, 0, 1_000)],
    }),
    agents: [explore],
    models: GO_MODELS,
    providers: GO_PROVIDERS,
    members: memberSet([explore]),
  }
  const view = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[0].head, " 1.explore   [built-in]       ")
  assert.equal(
    view.rows[0].head +
      BAR_GLYPH_FILLED.repeat(view.rows[0].filled) +
      BAR_GLYPH_EMPTY.repeat(BAR_CELLS - view.rows[0].filled),
    " 1.explore   [built-in]       ▓▓▓░░",
  )
  // The built-in instance row keeps R8's model label and never carries the tag.
  assert.equal(view.rows[1].head, " └ Inspect… Go/Grok 4.7       ")
  assert.equal(view.rows[1].head.includes(BUILTIN_TAG_TEXT), false)

  // Member regression twin: the same 16-cell label still renders in the slot.
  const coder = agent("coder", "coder", { model: { id: "kimi", providerID: "go" } })
  const memberView = panel(
    goSources([], [coder]),
    undefined,
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(memberView.rows[0].head, " 1.coder     Go/Kimi K3.1 Pro ")
  assert.equal(memberView.rows[0].head.includes(BUILTIN_TAG_TEXT), false)
})

test("T1 permanent built-in rows show the tag in built-in mode", () => {
  const agents = [
    agent("build", "build", { mode: "primary" }),
    agent("general", "general"),
    agent("explore", "explore"),
    agent("title", "title", { mode: "primary", hidden: true }),
  ]
  const view = panel(rootSources([], agents), undefined, 35, BODY_MAX_LINES, 0)
  assert.equal(view.mode, "builtin")
  assert.equal(view.total, 2)
  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].head + "░░░░░", " 1.explore   [built-in]       ░░░░░")
  assert.equal(view.rows[1].head + "░░░░░", " 2.general   [built-in]       ░░░░░")
  assert.equal(view.rows[0].state, "idle")
  assert.equal(view.rows[1].state, "idle")
})

test("T2 temporary built-in row shows the tag; its instance keeps the model", () => {
  const general = agent("general", "general", { color: "#00ff00" })
  const coder = agent("coder", "coder", { model: { id: "kimi", providerID: "go" } })
  const members = memberSet([general, coder])
  const audit = child("a-1", "general", 1_000, {
    title: "Audit",
    model: { id: "grok47", providerID: "go" },
  })
  const view = panel(
    goSources([audit], [general, coder], ["a-1"], members),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.rows.length, 3)
  assert.equal(view.rows[0].head, " 1.general   [built-in]       ")
  assert.equal(view.rows[0].state, "active")
  // The tag rides in the head, so it inherits the same row colour.
  assert.equal(view.rows[0].agentColor, "#00ff00")
  assert.equal(view.rows[1].head, " └ Audit    Go/Grok 4.7       ")
  assert.equal(view.rows[1].head.includes(BUILTIN_TAG_TEXT), false)
  assert.equal(view.rows[2].head, " 2.coder     Go/Kimi K3.1 Pro ")
})

test("T3 a live definition model is ignored on a built-in role row", () => {
  const explore = agent("explore", "explore", { model: { id: "kimi", providerID: "go" } })
  const coder = agent("coder", "coder", { model: { id: "kimi", providerID: "go" } })
  // Charter member set: explore can only appear as a temporary built-in row.
  const members = memberSet([coder, explore])
  const run = child("e-1", "explore", 1_000, { title: "x" })
  const view = panel(
    goSources([run], [explore, coder], ["e-1"], members),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  // explore resolves a definition model, yet its role row is still the tag.
  assert.equal(view.rows[0].head, " 1.explore   [built-in]       ")
  // The same 16-cell label on the member row renders unchanged.
  assert.equal(view.rows[2].head, " 2.coder     Go/Kimi K3.1 Pro ")
})

test("T4 the name clip never eats the tag", () => {
  const view = panel(
    rootSources([], [agent("explore", "1234567890")]),
    undefined,
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(view.rows[0].head, " 1.12345678… [built-in]       ")
  assert.equal(cellWidth(view.rows[0].head), 30)
})

test("T5 the tag follows the width series and a member row keeps the model rule", () => {
  const builtinHead = (width: number) =>
    panel(rootSources([], [agent("explore", "explore")]), undefined, width, BODY_MAX_LINES, 0)
      .rows[0].head
  assert.equal(builtinHead(35), " 1.explore   [built-in]       ")
  assert.equal(builtinHead(29), " 1.explore   [built-in] ")
  assert.equal(builtinHead(28), " 1.explore   [built-i… ")
  assert.equal(builtinHead(20), " 1.explore   … ")
  assert.equal(builtinHead(19), " 1.explore    ")

  const coder = agent("coder", "coder", { model: { id: "kimi", providerID: "go" } })
  const memberHead = panel(goSources([], [coder]), undefined, 28, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(memberHead, " 1.coder     Go/Kimi … ")
  assert.equal(memberHead.includes(BUILTIN_TAG_TEXT), false)
})

/* ------------------------------------------------------------------ */
/* A.10 instance-model visibility: C35/C36 and scenarios T6-T14.       */
/* ------------------------------------------------------------------ */

const KIMI = { id: "kimi", providerID: "go" }
const GROK = { id: "grok47", providerID: "go" }

/** Panel sources for the A.10 fixtures, with message data for the bars. */
function a10Sources(
  sessions: SessionInfo[],
  agents: AgentInfo[],
  running: string[],
  messages: Record<string, ReadonlyArray<TestMessage>> = {},
  members: MemberSet = memberSet(agents),
): Sources {
  return {
    sessions: fakeSessions([{ id: "root" }, ...sessions], running, messages),
    agents,
    models: GO_MODELS,
    providers: GO_PROVIDERS,
    members,
  }
}

/**
 * A.13/C36: an omitted-model instance head — indent, title padded to the
 * absorption budget `B = W − 9`, then the separator.
 */
function absorbedHead(text: string, width = DEFAULT_WIDTH, glyph: "├" | "└" = "└"): string {
  const budget = width - INSTANCE_REST_FIXED_CELLS + INSTANCE_TITLE_GAP_CELLS
  return ` ${glyph} ${text}${" ".repeat(budget - cellWidth(text))} `
}

test("T6 equal member models omit the instance model cell (C35)", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules" })
  const view = panel(
    a10Sources([run], [coder], ["c-1"], { "c-1": [assistant(50, 0, 1_000)] }, members),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  assert.equal(view.rows[0].head, " 1.coder     Go/Kimi K3.1 Pro ")
  assert.equal(view.rows[1].head, absorbedHead("Inspect modules"))
  assert.equal(cellWidth(view.rows[1].head), 30)
  assert.equal(view.rows[0].filled, 3)
  assert.equal(view.rows[1].filled, 3)
})

test("T7 differing member models render; the comparison precedes clipping", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])

  const differing = child("c-1", "coder", 1_000, { title: "Inspect modules", model: GROK })
  const shown = panel(
    a10Sources([differing], [coder], ["c-1"], { "c-1": [assistant(50, 0, 1_000)] }, members),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(shown.rows[1].head, " └ Inspect… Go/Grok 4.7       ")
  assert.equal(cellWidth(shown.rows[1].head), 30)

  // Both labels clip to `Go/Kimi K3.…`; only the unclipped comparison differs.
  const capped = child("c-2", "coder", 1_000, { title: "Inspect modules", model: { id: "kimi-max", providerID: "go" } })
  const view = panel(a10Sources([capped], [coder], ["c-2"], {}, members), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[1].head, " └ Inspect… Go/Kimi K3.…      ")
  assert.equal(fitModel("Go/Kimi K3.1 Pro Max", 12), "Go/Kimi K3.…")
  assert.equal(fitModel("Go/Kimi K3.1 Pro", 12), "Go/Kimi K3.…")
})

test("T8 a temporary built-in baseline is the live model, not the tag", () => {
  const general = agent("general", "general", { model: GROK })
  const coder = agent("coder", "coder")
  const members = memberSet([coder])
  const audit = child("g-1", "general", 1_000, { title: "Audit" })

  const equal = panel(a10Sources([audit], [general, coder], ["g-1"], {}, members), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(equal.rows[0].head, " 1.general   [built-in]       ")
  assert.equal(equal.rows[1].head, " └ Audit" + " ".repeat(22))
  assert.equal(equal.rows[1].head.includes(BUILTIN_TAG_TEXT), false)

  // Differing twin: the child's own session model is not the baseline.
  const own = child("g-2", "general", 1_000, { title: "Audit", model: KIMI })
  const differs = panel(a10Sources([own], [general, coder], ["g-2"], {}, members), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(differs.rows[1].head, " └ Audit    Go/Kimi K3.…      ")
})

test("T9 unknown == unknown is omitted; the asymmetric twin shows (C35, F29)", () => {
  const coder = agent("coder", "coder")
  const members = memberSet([coder])
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules" })

  const equal = panel(a10Sources([run], [coder], ["c-1"], {}, members), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(equal.rows[0].head, " 1.coder" + " ".repeat(22))
  assert.equal(equal.rows[1].head, absorbedHead("Inspect modules"))

  // Known snapshot baseline, live definition and session both without a model.
  const known = agent("coder", "coder", { model: KIMI })
  const knownMembers = memberSet([known])
  const asymmetric = panel(a10Sources([run], [coder], ["c-1"], {}, knownMembers), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(asymmetric.rows[1].head, " └ Inspect… unknown mod…      ")
})

test("T10 an instance that resolves shows; churn re-evaluates every pass", () => {
  const unknownRole = agent("coder", "coder")
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules", model: GROK })

  const before = panel(
    a10Sources([run], [unknownRole], ["c-1"], {}, memberSet([unknownRole])),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(before.rows[0].head, " 1.coder" + " ".repeat(22))
  assert.equal(before.rows[1].head, " └ Inspect… Go/Grok 4.7       ")
  assert.equal(before.rows[1].state, "active")

  // The next snapshot gains the same model: the row loses the cell with no
  // stored flag, no grace, and no timer side effect (A.8, A.10).
  const knownRole = agent("coder", "coder", { model: GROK })
  const after = panel(
    a10Sources([run], [unknownRole], ["c-1"], {}, memberSet([knownRole])),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )
  assert.equal(after.rows[1].head, absorbedHead("Inspect modules"))
  assert.equal(after.rows[1].state, "active")
  assert.equal(after.rows[1].tps, undefined)
})

test("T11 width pressure on the absorbed title (C36)", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules" })

  const at29 = panel(a10Sources([run], [coder], ["c-1"], {}, members), "root", 29, BODY_MAX_LINES, 0)
  assert.equal(at29.rows[1].head, absorbedHead("Inspect modules", 29))
  assert.equal(cellWidth(at29.rows[1].head), 24)

  const at19 = panel(a10Sources([run], [coder], ["c-1"], {}, members), "root", 19, BODY_MAX_LINES, 0)
  assert.equal(at19.rows[1].head, absorbedHead("Inspect m…", 19))
  assert.equal(cellWidth(at19.rows[1].head), 14)
  assert.equal(
    at19.rows[1].head + BAR_GLYPH_EMPTY.repeat(BAR_CELLS - at19.rows[1].filled),
    " └ Inspect m… ░░░░░",
  )

  // Shown at width 19: same geometry, different content.
  const own = child("c-2", "coder", 1_000, { title: "Inspect modules", model: GROK })
  const shown = panel(a10Sources([own], [coder], ["c-2"], {}, members), "root", 19, BODY_MAX_LINES, 0)
  assert.equal(shown.rows[1].head, " └ Inspect… … ")
  assert.equal(cellWidth(shown.rows[1].head), 14)
})

test("T12 mixed rows keep every bar in the last five columns", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])
  const sessions = [
    child("c-1", "coder", 1_000, { title: "Inspect modules" }),
    child("c-2", "coder", 2_000, { title: "Audit", model: GROK }),
  ]
  const view = panel(a10Sources(sessions, [coder], ["c-1", "c-2"], {}, members), "root", 35, BODY_MAX_LINES, 0)

  assert.equal(view.rows[0].head, " 1.coder     Go/Kimi K3.1 Pro ")
  assert.equal(view.rows[1].head, absorbedHead("Inspect modules", DEFAULT_WIDTH, "├"))
  assert.equal(view.rows[2].head, " └ Audit    Go/Grok 4.7       ")
  for (const row of view.rows) {
    assert.equal(cellWidth(row.head), 30)
    assert.equal(cellWidth(row.head) + BAR_CELLS, 35)
    assert.equal(row.head.slice(-1), " ")
  }
})

test("T13 the role rendering cap is not the comparison operand (C35)", () => {
  const coder = agent("coder", "coder", { model: { id: "kimi-maxx", providerID: "go" } })
  const members = memberSet([coder])
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules" })
  const view = panel(
    a10Sources([run], [coder], ["c-1"], { "c-1": [assistant(50, 0, 1_000)] }, members),
    "root",
    40,
    BODY_MAX_LINES,
    0,
  )

  // Width 40: the role text clips at 20 cells, the 21-cell resolved label is
  // still equal to the instance's, so the instance cell is omitted.
  assert.equal(view.rows[0].head, " 1.coder     Go/Kimi K3.1 Pro Ma…  ")
  assert.equal(cellWidth(view.rows[0].head), 35)
  assert.equal(view.rows[1].head, absorbedHead("Inspect modules", 40))
  assert.equal(cellWidth(view.rows[1].head), 35)
  assert.equal(view.rows[0].filled, 3)
  assert.equal(view.rows[1].filled, 3)
})

test("T14 variant-only difference compares equal on the short label", () => {
  const coder = agent("coder", "coder", { model: { id: "kimi", providerID: "go", variant: "high" } })
  const members = memberSet([coder])
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules", model: KIMI })
  const view = panel(
    a10Sources([run], [coder], ["c-1"], { "c-1": [assistant(50, 0, 1_000)] }, members),
    "root",
    35,
    BODY_MAX_LINES,
    0,
  )

  const full = labeler(GO_MODELS, GO_PROVIDERS)
  const short = labeler(GO_MODELS, GO_PROVIDERS, true)
  assert.equal(full({ id: "kimi", providerID: "go", variant: "high" }), "OpenCode Go/Kimi K3.1 Pro (high)")
  assert.equal(full(KIMI), "OpenCode Go/Kimi K3.1 Pro")
  assert.notEqual(full({ id: "kimi", providerID: "go", variant: "high" }), full(KIMI))
  assert.equal(short({ id: "kimi", providerID: "go", variant: "high" }), "Go/Kimi K3.1 Pro")
  assert.equal(short(KIMI), "Go/Kimi K3.1 Pro")

  assert.equal(view.rows[0].head, " 1.coder     Go/Kimi K3.1 Pro ")
  assert.equal(view.rows[1].head, absorbedHead("Inspect modules"))
  assert.equal(view.rows[0].filled, 3)
  assert.equal(view.rows[1].filled, 3)
})

test("T26 absorption on a member row is path-invariant (A.13, C36)", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules" })
  const sources = a10Sources([run], [coder], ["c-1"], { "c-1": [assistant(50, 0, 1_000)] }, members)

  const fallback = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  const dynamic = dynamicPanel(sources, "root", 35)

  // Equal labels → omitted; both paths use the same absorbed budget B = 26.
  assert.equal(fallback.rows[1].head, " └ Inspect modules            ")
  assert.equal(dynamic.rows[1].head, " └ Inspect modules            ")
  assert.equal(fallback.rows[1].head, absorbedHead("Inspect modules"))
  assert.equal(cellWidth(fallback.rows[1].head), 30)
  assert.equal(cellWidth(dynamic.rows[1].head), 30)
  assert.equal(fallback.rows[1].head.slice(-1), " ")
  assert.equal(fallback.rows[1].filled, 3)
  assert.equal(dynamic.rows[1].filled, 3)

  // Role rows keep their own path (A.11, unchanged by A.13).
  assert.equal(fallback.rows[0].head, " 1.coder     Go/Kimi K3.1 Pro ")
  assert.equal(dynamic.rows[0].head, " 1.coder      Go/Kimi K3.1 P… ")
})

test("T27 absorption on a temporary built-in row; the tag is not the operand", () => {
  const general = agent("general", "general", { model: GROK })
  const coder = agent("coder", "coder")
  const members = memberSet([coder])
  const run = child("g-1", "general", 1_000, { title: "Inspect modules" })
  const sources = a10Sources([run], [general, coder], ["g-1"], {}, members)

  const fallback = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  const dynamic = dynamicPanel(sources, "root", 35)

  assert.equal(fallback.rows[0].head, " 1.general   [built-in]       ")
  assert.equal(dynamic.rows[0].head, " 1.general    [built-in]      ")
  assert.equal(fallback.rows[1].head, " └ Inspect modules            ")
  assert.equal(dynamic.rows[1].head, " └ Inspect modules            ")
  assert.equal(fallback.rows[1].head.includes(BUILTIN_TAG_TEXT), false)
  assert.equal(cellWidth(fallback.rows[1].head), 30)
  assert.equal(cellWidth(dynamic.rows[1].head), 30)
})

test("T28 a short title keeps the old filler string byte for byte", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])
  const run = child("c-1", "coder", 1_000, { title: "Audit" })
  const view = panel(a10Sources([run], [coder], ["c-1"], {}, members), "root", 35, BODY_MAX_LINES, 0)

  // `Audit` is 5 cells, so the absorbed B = 26 pads exactly as the old filler
  // did: 22 spaces after the title (21 pad + 1 separator).
  assert.equal(view.rows[1].head, " └ Audit                      ")
  assert.equal(view.rows[1].head, " └ Audit" + " ".repeat(22))
  assert.equal(view.rows[1].head, absorbedHead("Audit"))
  assert.equal(cellWidth(view.rows[1].head), 30)
})

test("T29 shown-model rows are byte-for-byte unchanged (A.13 regression)", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules", model: GROK })
  const sources = a10Sources([run], [coder], ["c-1"], {}, members)

  const fallback = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  const dynamic = dynamicPanel(sources, "root", 35)

  assert.equal(fallback.rows[1].head, " └ Inspect… Go/Grok 4.7       ")
  assert.equal(dynamic.rows[1].head, " └ Inspect… Go/Grok 4.7       ")
  assert.equal(fallback.rows[1].head, dynamic.rows[1].head)
  // Still the C11 8-cell title field, not the absorbed budget.
  assert.equal(fallback.rows[1].head.slice(3, 11), "Inspect…")

  // The built-in-instance twin also keeps the shown layout (C34).
  const explore = agent("explore", "explore")
  const own = child("e-1", "explore", 1_000, { title: "Inspect modules", model: GROK })
  const builtin = a10Sources([own], [explore], ["e-1"], {}, memberSet([explore]))
  assert.equal(panel(builtin, "root", 35, BODY_MAX_LINES, 0).rows[1].head, " └ Inspect… Go/Grok 4.7       ")
})

test("T30 width pressure and the fallback-takeover edge (C36, C49)", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])

  const at = (width: number) => {
    const run = child("c-1", "coder", 1_000, { title: "Inspect modules" })
    const sources = a10Sources([run], [coder], ["c-1"], {}, members)
    return {
      fallback: panel(sources, "root", width, BODY_MAX_LINES, 0).rows[1].head,
      dynamic: dynamicPanel(sources, "root", width).rows[1].head,
    }
  }

  // Omitted rows are path-invariant at every width.
  const cases: Array<[number, string]> = [
    [30, absorbedHead("Inspect modules", 30)],
    [29, absorbedHead("Inspect modules", 29)],
    [28, absorbedHead("Inspect modules", 28)],
    [24, absorbedHead("Inspect modules", 24)],
    [23, absorbedHead("Inspect modul…", 23)],
    [19, absorbedHead("Inspect m…", 19)],
  ]
  for (const [width, expected] of cases) {
    const rows = at(width)
    assert.equal(rows.fallback, expected, `fallback at W ${width}`)
    assert.equal(rows.dynamic, expected, `dynamic at W ${width}`)
    assert.equal(rows.fallback, rows.dynamic)
    assert.equal(cellWidth(rows.fallback), width - BAR_CELLS)
    assert.equal(rows.fallback.slice(-1), " ")
  }

  // The pinned design strings: W 24 fits whole, W 23 clips one cell over.
  assert.equal(at(24).fallback, " └ Inspect modules ")
  assert.equal(at(23).fallback, " └ Inspect modul… ")
  assert.equal(at(19).fallback, " └ Inspect m… ")
})

test("T31 long-title clip boundary at W 35 (C36)", () => {
  const coder = agent("coder", "coder", { model: KIMI })
  const members = memberSet([coder])

  const at = (title: string) => {
    const run = child("c-1", "coder", 1_000, { title })
    return panel(a10Sources([run], [coder], ["c-1"], {}, members), "root", 35, BODY_MAX_LINES, 0).rows[1].head
  }

  // 16 cells fit B = 26 whole.
  assert.equal(at("Inspect modules!"), absorbedHead("Inspect modules!"))
  assert.equal(at("Inspect modules!"), " └ Inspect modules!           ")
  // Exactly B = 26 fits whole: no ellipsis.
  assert.equal(at("Inspect modules and audits"), absorbedHead("Inspect modules and audits"))
  assert.equal(at("Inspect modules and audits"), " └ Inspect modules and audits ")
  // B + 1 = 27 clips to the 25-cell prefix plus `…`.
  assert.equal(clip("Inspect modules and auditsX", 26), "Inspect modules and audit…")
  assert.equal(at("Inspect modules and auditsX"), absorbedHead("Inspect modules and audit…"))
  // A longer title clips to the same 26-cell string.
  assert.equal(at("Inspect modules and audit logs"), absorbedHead("Inspect modules and audit…"))
  for (const head of [
    at("Inspect modules!"),
    at("Inspect modules and audits"),
    at("Inspect modules and auditsX"),
    at("Inspect modules and audit logs"),
  ]) {
    assert.equal(cellWidth(head), 30)
    assert.equal(head.slice(-1), " ")
  }
})

test("R9 live filter matches the full model behind the clipped picker title", () => {
  // 98 cells: the 96-cell display clips after 95 cells, losing the tail.
  const model = `${"a".repeat(92)}TAILZZ`
  const row: RunningSubagent = {
    sessionID: "ses_tail",
    agent: "explore",
    model,
    title: "Inspect repo",
    since: 1_000,
  }
  const title = pickerTitle(row.agent, row.model)
  const shownModel = title.split(" · ")[1]
  assert.equal(cellWidth(shownModel), PICKER_MODEL_CELLS)
  assert.equal(shownModel, `${"a".repeat(92)}TAI…`)
  assert.equal(title.includes("TAILZZ"), false)

  // Fits: a term only in the clipped-away tail still finds the raw record.
  assert.equal(filterRows([row], "tailzz").length, 1)
  // Does not fit: a term in neither the full fields nor the clipped display.
  assert.equal(filterRows([row], "zzzz").length, 0)
  assert.equal(title.toLowerCase().includes("zzzz"), false)
})

/* ------------------------------------------------------------------ */
/* A.11 dynamic width: C37-C50 and scenarios T15-T23, exact values.    */
/* ------------------------------------------------------------------ */

/** The one probe shape C46 accepts as available. */
const SIDE_PROBE: WidthProbe = {
  placement: "side",
  visible: true,
  opened: true,
  loaded: true,
  cssWidth: 280,
}

/** A panel pass on the proportional path. */
function dynamicPanel(
  sources: Sources,
  sessionID: string | undefined,
  width: number,
  now = 0,
) {
  return panel(sources, sessionID, width, BODY_MAX_LINES, now, GRACE_MS, true)
}

/** A non-builtin member with a display name and a model (member rows print it). */
function memberRole(id: string, name: string, model = KIMI): AgentInfo {
  return agent(id, name, { model })
}

test("C37 CELL_PX = 8 divides the detected CSS width, half-up", () => {
  assert.equal(CELL_PX, 8)
  assert.equal(resolveCellPx(undefined), CELL_PX)
  assert.equal(resolveCellPx(null), CELL_PX)
  assert.equal(resolveCellPx(0), CELL_PX)
  assert.equal(resolveCellPx(-2), CELL_PX)
  assert.equal(resolveCellPx(Number.NaN), CELL_PX)
  assert.equal(resolveCellPx(Number.POSITIVE_INFINITY), CELL_PX)
  assert.equal(resolveCellPx(8), 8)
  assert.equal(resolveCellPx(10), 10)

  const probe = (cssWidth: number): WidthProbe => ({ ...SIDE_PROBE, cssWidth })
  assert.equal(detectedCells(probe(280), CELL_PX), 35)
  assert.equal(detectedCells(probe(288), CELL_PX), 36)
  // 260 / 8 = 32.5 rounds up; truncating or half-even gives 32.
  assert.equal(detectedCells(probe(260), CELL_PX), 33)
  assert.equal(detectedCells(probe(259), CELL_PX), 32)
})

test("D1/F40 debug dump path: XDG_STATE_HOME wins, empty is unset, home fallback", () => {
  const file = "opencode/subagent-model-debug.jsonl"
  // Set: the state path wins outright, no home segment.
  assert.equal(debugDumpPath("/state/live", "/home/u"), `/state/live/${file}`)
  // Unset: the home fallback, never a relative path.
  assert.equal(debugDumpPath(undefined, "/home/u"), `/home/u/.local/state/${file}`)
  // Set but empty is unset per the XDG spec, so the home fallback wins.
  assert.equal(debugDumpPath("", "/home/u"), `/home/u/.local/state/${file}`)
  // Whitespace-only trims to empty, so it is unset too: no relative path.
  assert.equal(debugDumpPath("   ", "/home/u"), `/home/u/.local/state/${file}`)
  // Surrounding spaces are trimmed off the joined value, not kept.
  assert.equal(debugDumpPath("  /state/padded  ", "/home/u"), `/state/padded/${file}`)
  // A trailing slash does not double up; an existing file is still one segment.
  assert.equal(debugDumpPath("/state/live/", "/home/u"), `/state/live/${file}`)
  // A symlink-looking value is just a string: no canonicalisation, no special case.
  assert.equal(
    debugDumpPath("/tmp/opencode/../state", "/home/u"),
    `/tmp/opencode/../state/${file}`,
  )
  assert.equal(debugDumpPath("/tmp/link", "/home/u"), `/tmp/link/${file}`)
})

test("C38 ROLE_REST_FIXED_CELLS = 10 gives rest W - 10", () => {
  assert.equal(ROLE_REST_FIXED_CELLS, 10)
  assert.deepEqual(roleSplit(35, true), { leading: 10, model: 15, proportional: true })
  assert.deepEqual(roleSplit(24, true), { leading: 6, model: 8, proportional: true })
  // W 19: rest 9, a floor binds, so the fallback fields govern.
  assert.deepEqual(roleSplit(19, true), { leading: ROLE_NAME_CELLS, model: 0, proportional: false })
})

test("C39 INSTANCE_REST_FIXED_CELLS = 10 gives the title/model rest", () => {
  assert.equal(INSTANCE_REST_FIXED_CELLS, 10)
  assert.deepEqual(instanceSplit(35, true), { leading: 8, model: 17, proportional: true })
  assert.deepEqual(instanceSplit(24, true), { leading: 6, model: 8, proportional: true })
  assert.deepEqual(instanceSplit(19, true), { leading: INSTANCE_TITLE_CELLS, model: 1, proportional: false })
})

test("C40 ROLE_NAME_SHARE = 2/5 rounds half-up", () => {
  assert.equal(ROLE_NAME_SHARE_NUM, 2)
  assert.equal(ROLE_NAME_SHARE_DEN, 5)
  assert.equal(roleSplit(35, true).leading, 10) // rest 25 → 10.0
  assert.equal(roleSplit(37, true).leading, 11) // rest 27 → 10.8
  assert.equal(roleSplit(50, true).leading, 16) // rest 40 → 16.0
  // rest 13 → 5, below the C42 floor, so the fallback fields govern.
  assert.equal(roleSplit(23, true).proportional, false)
  assert.equal(roleSplit(23, true).leading, ROLE_NAME_CELLS)
  // rest 14 → 6, the first non-binding split.
  assert.equal(roleSplit(24, true).proportional, true)
  assert.equal(roleSplit(24, true).leading, 6)
})

test("C41 INSTANCE_TITLE_SHARE = 2/5 rounds half-up, capped at 8", () => {
  assert.equal(INSTANCE_TITLE_SHARE_NUM, 2)
  assert.equal(INSTANCE_TITLE_SHARE_DEN, 5)
  assert.equal(instanceSplit(28, true).leading, 7) // rest 18 → 7.2
  assert.equal(instanceSplit(29, true).leading, 8) // rest 19 → 7.6
  assert.equal(instanceSplit(50, true).leading, INSTANCE_TITLE_CELLS) // rest 40 → 16, capped 8
  assert.equal(instanceSplit(50, true).model, 32)
  assert.equal(instanceSplit(23, true).proportional, false) // rest 13 → 5, floor binds
  assert.equal(instanceSplit(24, true).leading, 6) // rest 14 → 5.6
})

test("C42 ROLE_NAME_MIN_CELLS = 6 binds at rest 13", () => {
  assert.equal(ROLE_NAME_MIN_CELLS, 6)
  const fits = dynamicPanel(goSources([], [memberRole("designer", "designer")]), undefined, 24)
  assert.equal(fits.rows[0].head, " 1.desig… Go/Kimi… ")
  const floor = dynamicPanel(goSources([], [memberRole("designer", "designer")]), undefined, 23)
  assert.equal(floor.rows[0].head, " 1.designer  …/K… ")
  assert.equal(cellWidth(floor.rows[0].head), 18)
})

test("C43 ROLE_MODEL_MIN_CELLS = 4 guards the model field", () => {
  assert.equal(ROLE_MODEL_MIN_CELLS, 4)
  // Fits: rest 14 → model 8.
  assert.equal(roleSplit(24, true).model, 8)
  // Synthetic guard: W >= 19 means rest >= 9, where the name floor binds first.
  assert.deepEqual(roleSplit(19, true), { leading: ROLE_NAME_CELLS, model: 0, proportional: false })
})

test("C44 INSTANCE_TITLE_MIN_CELLS = 6 binds at rest 13", () => {
  assert.equal(INSTANCE_TITLE_MIN_CELLS, 6)
  const fits = instanceSplit(24, true)
  assert.equal(fits.leading, 6)
  assert.equal(fits.proportional, true)
  const floor = instanceSplit(23, true)
  assert.equal(floor.leading, INSTANCE_TITLE_CELLS)
  assert.equal(floor.proportional, false)
})

test("C45 INSTANCE_MODEL_MIN_CELLS = 4 guards the model field", () => {
  assert.equal(INSTANCE_MODEL_MIN_CELLS, 4)
  assert.equal(instanceSplit(24, true).model, 8)
  assert.deepEqual(instanceSplit(19, true), {
    leading: INSTANCE_TITLE_CELLS,
    model: 1,
    proportional: false,
  })
})

test("C46 detection is available only for an open, loaded, visible side region", () => {
  assert.deepEqual(rowWidth(35, CELL_PX, SIDE_PROBE), { W: 35, dynamic: true, rung: 3 })
  assert.equal(detectedCells({ ...SIDE_PROBE, cssWidth: 260 }, CELL_PX), 33)

  const unavailable: Array<WidthProbe | undefined> = [
    undefined,
    { ...SIDE_PROBE, loaded: false },
    { ...SIDE_PROBE, opened: false },
    { ...SIDE_PROBE, visible: false },
    { ...SIDE_PROBE, placement: "mobile" },
    { ...SIDE_PROBE, cssWidth: 0 },
    { ...SIDE_PROBE, cssWidth: Number.NaN },
  ]
  for (const probe of unavailable) {
    assert.equal(detectedCells(probe, CELL_PX), undefined)
    assert.deepEqual(rowWidth(35, CELL_PX, probe), { W: 35, dynamic: false })
  }
})

test("C47 rowWidth caps by declared width and floors at 19", () => {
  const probe = (cssWidth: number): WidthProbe => ({ ...SIDE_PROBE, cssWidth })
  // Detection can only narrow, never widen.
  assert.deepEqual(rowWidth(35, CELL_PX, probe(400)), { W: 35, dynamic: true, rung: 3 })
  assert.deepEqual(rowWidth(35, CELL_PX, probe(224)), { W: 28, dynamic: true, rung: 3 })
  // A detected 12 is floored to 19 exactly as a configured 12 is.
  assert.deepEqual(rowWidth(35, CELL_PX, probe(96)), { W: 19, dynamic: true, rung: 3 })
  assert.deepEqual(rowWidth(18, CELL_PX, undefined), { W: 19, dynamic: false })
  assert.deepEqual(rowWidth(35, CELL_PX, undefined), { W: 35, dynamic: false })
})

test("C48 role split strings: dynamic and fallback at the same and other widths", () => {
  const agents = [memberRole("coder", "explore")]
  const at = (width: number, dynamic: boolean) =>
    dynamic
      ? dynamicPanel(goSources([], agents), undefined, width).rows[0].head
      : panel(goSources([], agents), undefined, width, BODY_MAX_LINES, 0).rows[0].head

  assert.equal(at(35, true), " 1.explore    Go/Kimi K3.1 P… ")
  assert.equal(cellWidth(at(35, true)), 30)
  assert.equal(at(35, false), " 1.explore   Go/Kimi K3.1 Pro ")
  assert.equal(cellWidth(at(35, false)), 30)
  assert.equal(at(50, true), " 1.explore          Go/Kimi K3.1 Pro         ")
  assert.equal(cellWidth(at(50, true)), 45)
  assert.equal(at(23, true), " 1.explore   …/K… ")
  assert.equal(cellWidth(at(23, true)), 18)
})

test("C49 instance split strings: cap, unused title cells, and the floor", () => {
  const coder = memberRole("coder", "coder")
  const at = (width: number, dynamic: boolean) => {
    const run = child("c-1", "coder", 1_000, { title: "Inspect modules", model: GROK })
    const sources = a10Sources([run], [coder], ["c-1"], {})
    return dynamic
      ? dynamicPanel(sources, "root", width).rows[1].head
      : panel(sources, "root", width, BODY_MAX_LINES, 0).rows[1].head
  }

  assert.equal(at(28, true), " └ Inspec… Go/Grok 4.7 ")
  assert.equal(cellWidth(at(28, true)), 23)
  assert.equal(at(28, false), " └ Inspect… Go/Grok 4… ")
  assert.equal(cellWidth(at(28, false)), 23)
  // W 35: T caps at 8, so both paths agree.
  assert.equal(at(35, true), " └ Inspect… Go/Grok 4.7       ")
  assert.equal(at(35, true), at(35, false))
  // W 24: T 6, M 8.
  assert.equal(at(24, true), " └ Inspe… Go/Grok… ")
  assert.equal(cellWidth(at(24, true)), 19)
  // W 23: the title floor binds and the fallback fields govern.
  assert.equal(at(23, true), at(23, false))
})

test("C50 the tag rides in the derived model field, whole at M >= 10", () => {
  const agents = [agent("explore", "explore")]
  const at = (width: number, dynamic: boolean) =>
    dynamic
      ? dynamicPanel(goSources([], agents), undefined, width).rows[0].head
      : panel(goSources([], agents), undefined, width, BODY_MAX_LINES, 0).rows[0].head

  assert.equal(at(26, true), " 1.explo… [built-in] ")
  assert.equal(at(26, true).includes(BUILTIN_TAG_TEXT), true)
  assert.equal(at(25, true), " 1.explo… [built-i… ")
  assert.equal(at(25, true).includes(BUILTIN_TAG_TEXT), false)
  assert.equal(at(35, true), " 1.explore    [built-in]      ")
  assert.equal(at(28, false), " 1.explore   [built-i… ")
})

test("the §1.4 width ladder: role N/M and instance T/M", () => {
  const ladder = [
    { W: 19, role: { leading: 9, model: 0, proportional: false }, instance: { leading: 8, model: 1, proportional: false } },
    { W: 23, role: { leading: 9, model: 4, proportional: false }, instance: { leading: 8, model: 5, proportional: false } },
    { W: 24, role: { leading: 6, model: 8, proportional: true }, instance: { leading: 6, model: 8, proportional: true } },
    { W: 26, role: { leading: 6, model: 10, proportional: true }, instance: { leading: 6, model: 10, proportional: true } },
    { W: 28, role: { leading: 7, model: 11, proportional: true }, instance: { leading: 7, model: 11, proportional: true } },
    { W: 29, role: { leading: 8, model: 11, proportional: true }, instance: { leading: 8, model: 11, proportional: true } },
    { W: 35, role: { leading: 10, model: 15, proportional: true }, instance: { leading: 8, model: 17, proportional: true } },
    { W: 50, role: { leading: 16, model: 24, proportional: true }, instance: { leading: 8, model: 32, proportional: true } },
    { W: 80, role: { leading: 28, model: 42, proportional: true }, instance: { leading: 8, model: 62, proportional: true } },
  ]
  for (const row of ladder) {
    assert.deepEqual(roleSplit(row.W, true), row.role, `role at W ${row.W}`)
    assert.deepEqual(instanceSplit(row.W, true), row.instance, `instance at W ${row.W}`)
  }
})

test("T15 proportional role split at W 35 (C48)", () => {
  const agents = [memberRole("coder", "explore")]
  const head = dynamicPanel(goSources([], agents), undefined, 35).rows[0].head
  assert.equal(head, " 1.explore    Go/Kimi K3.1 P… ")
  assert.equal(cellWidth(head) + BAR_CELLS, 35)

  const fallback = panel(goSources([], agents), undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(fallback, " 1.explore   Go/Kimi K3.1 Pro ")
})

test("T16 cap and narrowing (C47)", () => {
  const agents = [memberRole("coder", "explore")]
  const sources = goSources([], agents)

  const capped = rowWidth(35, CELL_PX, { ...SIDE_PROBE, cssWidth: 400 })
  assert.deepEqual(capped, { W: 35, dynamic: true, rung: 3 })
  assert.equal(dynamicPanel(sources, undefined, capped.W).rows[0].head, " 1.explore    Go/Kimi K3.1 P… ")

  const wider = rowWidth(40, CELL_PX, { ...SIDE_PROBE, cssWidth: 400 })
  assert.deepEqual(wider, { W: 40, dynamic: true, rung: 3 })
  assert.equal(dynamicPanel(sources, undefined, wider.W).rows[0].head, " 1.explore      Go/Kimi K3.1 Pro   ")
  assert.equal(cellWidth(dynamicPanel(sources, undefined, wider.W).rows[0].head), 35)

  const narrower = rowWidth(35, CELL_PX, { ...SIDE_PROBE, cssWidth: 224 })
  assert.deepEqual(narrower, { W: 28, dynamic: true, rung: 3 })
  assert.equal(dynamicPanel(sources, undefined, narrower.W).rows[0].head, " 1.explore Go/Kimi K3… ")
  assert.equal(cellWidth(dynamicPanel(sources, undefined, narrower.W).rows[0].head), 23)
})

test("T17 tag edge at W 28 (C50)", () => {
  const agents = [agent("explore", "explore")]
  const sources = goSources([], agents)
  assert.equal(
    panel(sources, undefined, 28, BODY_MAX_LINES, 0).rows[0].head,
    " 1.explore   [built-i… ",
  )
  assert.equal(dynamicPanel(sources, undefined, 28).rows[0].head, " 1.explore [built-in]  ")
  assert.equal(cellWidth(dynamicPanel(sources, undefined, 28).rows[0].head), 23)
})

test("T18 proportional instance split at W 28 (C49)", () => {
  const coder = memberRole("coder", "coder")
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules", model: GROK })
  const sources = a10Sources([run], [coder], ["c-1"], {})

  assert.equal(dynamicPanel(sources, "root", 28).rows[1].head, " └ Inspec… Go/Grok 4.7 ")
  assert.equal(
    panel(sources, "root", 28, BODY_MAX_LINES, 0).rows[1].head,
    " └ Inspect… Go/Grok 4… ",
  )
})

test("T19 the title cap sends unused share cells to the model field (C49)", () => {
  const coder = memberRole("coder", "coder")
  const run = child("c-1", "coder", 1_000, { title: "Inspect modules", model: GROK })
  const sources = a10Sources([run], [coder], ["c-1"], {})

  const at35 = dynamicPanel(sources, "root", 35).rows[1].head
  assert.equal(at35, " └ Inspect… Go/Grok 4.7       ")
  assert.equal(cellWidth(at35), 30)

  const at50 = dynamicPanel(sources, "root", 50).rows[1].head
  assert.equal(at50, " └ Inspect… Go/Grok 4.7" + " ".repeat(22))
  assert.equal(cellWidth(at50), 45)
  assert.equal(at50.slice(12, 23), "Go/Grok 4.7")
  // A title field left at the uncapped share would start the label 8 cells later.
  assert.notEqual(at50.slice(12, 23), " ".repeat(8) + "Go/")
})

test("T20 the name floor binds at W 23 and selects the fallback arithmetic", () => {
  const agents = [
    agent("designer", "designer", { model: { id: "kimi-only", providerID: "go" } }),
  ]
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }]),
    agents,
    models: [{ id: "kimi-only", modelID: "kimi-only", providerID: "go", name: "Kimi" }],
    providers: GO_PROVIDERS,
    members: memberSet(agents),
  }
  assert.deepEqual(roleSplit(23, true), {
    leading: ROLE_NAME_CELLS,
    model: 4,
    proportional: false,
  })
  const head = dynamicPanel(sources, undefined, 23).rows[0].head
  assert.equal(head, " 1.designer  …/K… ")
  assert.equal(cellWidth(head), 18)
  // If the split were applied anyway, the content would differ.
  assert.notEqual(head, " 1.desi… Go/Kimi  ")
})

test("T21 a live width change rebuilds rows and nothing else", () => {
  const NOW = 100_000
  const coder = memberRole("coder", "coder")
  const active = child("a-1", "coder", 1_000, { title: "Active", model: GROK })
  const grace = child("g-1", "coder", 2_000, {
    title: "Broke",
    outcome: "failed",
    time: { created: 2_000, updated: NOW - 29_999 },
  })
  const sources = a10Sources([active, grace], [coder], ["a-1"], {
    "a-1": [assistant(50, 0, 1_000)],
  })

  const at35 = dynamicPanel(sources, "root", 35, NOW)
  const at50 = dynamicPanel(sources, "root", 50, NOW)

  for (const view of [at35, at50]) {
    assert.equal(view.working, 1)
    assert.equal(view.total, 1)
    assert.equal(view.more, 0)
    assert.deepEqual(
      view.rows.map((row) => row.state),
      ["active", "active", "grace"],
    )
    assert.deepEqual(
      view.rows.map((row) => row.filled),
      [3, 3, 0],
    )
    assert.equal(view.rows[0].tps, 50)
    assert.equal(view.rows[1].tps, 50)
    assert.equal(view.rows[2].tps, undefined)
    assert.equal(view.rows[0].head.startsWith(" 1.coder"), true)
  }

  assert.equal(cellWidth(at35.rows[0].head), 30)
  assert.equal(cellWidth(at35.rows[1].head), 30)
  assert.equal(cellWidth(at50.rows[0].head), 45)
  assert.equal(cellWidth(at50.rows[1].head), 45)
  assert.equal(cellWidth(at50.rows[1].head) + BAR_CELLS, 50)
})

test("T22 every unavailable probe yields the configured-width fallback (C46)", () => {
  const agents = [memberRole("coder", "explore")]
  const sources = goSources([], agents)
  // The TUI resolves `usePanel` once at setup and invokes that accessor per
  // pass through `resolveFrame()` inside the guarded memo (§1.4); these probes
  // are what it passes on.
  const unavailable: Array<WidthProbe | undefined> = [
    undefined,
    { ...SIDE_PROBE, loaded: false },
    { ...SIDE_PROBE, opened: false },
    { ...SIDE_PROBE, visible: false },
    { ...SIDE_PROBE, placement: "mobile" },
    { ...SIDE_PROBE, cssWidth: 0 },
    { ...SIDE_PROBE, cssWidth: Number.NaN },
  ]
  for (const probe of unavailable) {
    const width = rowWidth(35, CELL_PX, probe)
    assert.equal(width.dynamic, false)
    assert.equal(width.W, 35)
    assert.equal(
      panel(sources, undefined, width.W, BODY_MAX_LINES, 0, GRACE_MS, width.dynamic).rows[0].head,
      " 1.explore   Go/Kimi K3.1 Pro ",
    )
  }

  const available = rowWidth(35, CELL_PX, SIDE_PROBE)
  assert.equal(available.dynamic, true)
  assert.equal(
    panel(sources, undefined, available.W, BODY_MAX_LINES, 0, GRACE_MS, available.dynamic).rows[0]
      .head,
    " 1.explore    Go/Kimi K3.1 P… ",
  )
})

test("T23 the name budget is the full proportional field (C5, C48, F31)", () => {
  const agents = [memberRole("coder", "design-review")]

  const dynamic = dynamicPanel(goSources([], agents), undefined, 35).rows[0].head
  assert.equal(dynamic, " 1.design-re… Go/Kimi K3.1 P… ")
  assert.equal(cellWidth(dynamic), 30)

  const fallback = panel(goSources([], agents), undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(fallback, " 1.design-r… Go/Kimi K3.1 Pro ")
  assert.equal(cellWidth(fallback), 30)

  const wide = dynamicPanel(goSources([], agents), undefined, 50).rows[0].head
  assert.equal(wide, " 1.design-review    Go/Kimi K3.1 Pro         ")
  assert.equal(wide.slice(3, 19), "design-review   ")
  assert.equal(cellWidth(wide), 45)
  // A 9-cell name clip would underfill the head.
  assert.notEqual(dynamic, " 1.design-r… Go/Kimi K3.1 P… ")
})

test("T4 dynamic twin: a 10-cell built-in name fills the N=10 field beside the tag", () => {
  const agents = [agent("explore", "1234567890")]
  const sources = goSources([], agents)

  const dynamic = dynamicPanel(sources, undefined, 35).rows[0].head
  assert.equal(dynamic, " 1.1234567890 [built-in]      ")
  assert.equal(cellWidth(dynamic), 30)
  assert.equal(dynamic.slice(3, 13), "1234567890")
  assert.equal(dynamic.includes(BUILTIN_TAG_TEXT), true)

  // Does not fit: the fallback path clips the name to its 9-cell field.
  const fallback = panel(sources, undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(fallback, " 1.12345678… [built-in]       ")
  assert.equal(cellWidth(fallback), 30)
  assert.notEqual(dynamic, fallback)
  // A dynamic name budget miscounted as 9 would render a 29-cell head.
  assert.equal(cellWidth(" 1.12345678… [built-in]      "), 29)
})

test("C5 dynamic twin: a 10-cell name renders whole in the N=10 field", () => {
  const fits = [agent("coder", "1234567890")]
  const dynamic = dynamicPanel(goSources([], fits), undefined, 35).rows[0].head
  assert.equal(dynamic, " 1.1234567890" + " ".repeat(17))
  assert.equal(cellWidth(dynamic), 30)
  assert.equal(dynamic.slice(3, 13), "1234567890")

  const fallback = panel(goSources([], fits), undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(fallback, " 1.12345678…" + " ".repeat(18))
  assert.equal(cellWidth(fallback), 30)

  // Does not fit on the dynamic path: a 13-cell name clips to the 10-cell field.
  const long = [agent("coder", "design-review")]
  const clipped = dynamicPanel(goSources([], long), undefined, 35).rows[0].head
  assert.equal(clipped, " 1.design-re…" + " ".repeat(17))
  assert.equal(cellWidth(clipped), 30)
  assert.equal(clipped.slice(3, 13), "design-re…")
})

/* ------------------------------------------------------------------ */
/* A.12 three-rung width: C51-C53 and scenarios T24-T25, exact values. */
/* ------------------------------------------------------------------ */

/** Rung 2's divisor: 1600 device pixels over 100 terminal columns. */
const RUNG2_METRICS: RuntimeMetrics = {
  resolutionWidth: 1600,
  rendererColumns: 100,
}

test("C51 rung 1 accepts a strictly wider box and falls through on equality or overflow", () => {
  const probe = { ...SIDE_PROBE, cssWidth: 280 }

  // Fits: a strictly wider ancestor is the authoritative cell count.
  assert.deepEqual(selectCells(probe, { layoutCells: 40 }, CELL_PX), { cells: 40, rung: 1 })
  // The one-cell strict edge.
  assert.deepEqual(
    selectCells(probe, { layoutCells: 36, boxCells: 36, rowsCells: 35 }, CELL_PX),
    { cells: 36, rung: 1 },
  )

  // Does not fit: equality is not authority; rows wider than the box. The host
  // projects both to `layoutCells: undefined`, which falls to the next rung.
  assert.deepEqual(
    selectCells(probe, { layoutCells: undefined, boxCells: 35, rowsCells: 35 }, CELL_PX),
    { cells: 35, rung: 3 },
  )
  assert.deepEqual(
    selectCells(probe, { layoutCells: undefined, boxCells: 30, rowsCells: 35 }, CELL_PX),
    { cells: 35, rung: 3 },
  )

  // A non-positive or non-finite ancestor width is never authority.
  for (const layoutCells of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      selectCells(probe, { layoutCells, boxCells: layoutCells, rowsCells: 35 }, CELL_PX),
      { cells: 35, rung: 3 },
      `layoutCells ${layoutCells}`,
    )
  }

  // C47 carries the strict win into W and the record.
  assert.deepEqual(
    rowWidth(40, CELL_PX, probe, { layoutCells: 36, boxCells: 36, rowsCells: 35 }),
    { W: 36, dynamic: true, rung: 1, accepted: 36 },
  )
})

test("C52 runtimeCellPx is resolution pixels over renderer columns, both positive", () => {
  // Fits: the divisor is measured, never assumed.
  assert.equal(runtimeCellPx({ resolutionWidth: 1600, rendererColumns: 200 }), 8)
  assert.equal(runtimeCellPx({ resolutionWidth: 1000, rendererColumns: 120 }), 1000 / 120)
  assert.deepEqual(
    selectCells(
      { ...SIDE_PROBE, cssWidth: 280 },
      { resolutionWidth: 1600, rendererColumns: 200 },
      CELL_PX,
    ),
    { cells: 35, rung: 2 },
  )
  assert.deepEqual(
    selectCells(
      { ...SIDE_PROBE, cssWidth: 250 },
      { resolutionWidth: 1000, rendererColumns: 120 },
      CELL_PX,
    ),
    { cells: 30, rung: 2 },
  )

  // Does not fit: no metrics, no pixel resolution, a zero or non-finite side.
  const unavailable: Array<RuntimeMetrics | undefined> = [
    undefined,
    {},
    { resolutionWidth: undefined, rendererColumns: 100 },
    { resolutionWidth: 1600, rendererColumns: 0 },
    { resolutionWidth: 0, rendererColumns: 100 },
    { resolutionWidth: Number.NaN, rendererColumns: 100 },
    { resolutionWidth: 1600, rendererColumns: Number.NaN },
    { resolutionWidth: Number.POSITIVE_INFINITY, rendererColumns: 100 },
  ]
  for (const metrics of unavailable) {
    assert.equal(runtimeCellPx(metrics), undefined)
    // Rung 2 skips; the css width still reaches rung 3.
    assert.deepEqual(
      selectCells({ ...SIDE_PROBE, cssWidth: 280 }, metrics, CELL_PX),
      { cells: 35, rung: 3 },
    )
  }
})

test("C53 stable box keeps only a record written in this activation", () => {
  const probe = { ...SIDE_PROBE, cssWidth: 360 }

  // Fits: rows, box and the record agree; rung 1 keeps the adopted width and
  // does not consult rung 2 even though it would say 23.
  assert.deepEqual(
    rowWidth(40, CELL_PX, probe, { boxCells: 40, rowsCells: 40, ...RUNG2_METRICS }, 40),
    { W: 40, dynamic: true, rung: 1, accepted: 40 },
  )
  // The stable box reads `boxCells`, not `layoutCells`: no strict win needed.
  assert.deepEqual(
    rowWidth(40, CELL_PX, probe, { boxCells: 40, rowsCells: 40 }, 40),
    { W: 40, dynamic: true, rung: 1, accepted: 40 },
  )

  // Does not fit: no record, a stale record, a narrower box, or failed gates.
  const noRecord = rowWidth(40, CELL_PX, probe, {
    boxCells: 40,
    rowsCells: 40,
    ...RUNG2_METRICS,
  })
  assert.deepEqual(noRecord, { W: 23, dynamic: true, rung: 2 })
  assert.equal(noRecord.accepted, undefined)

  const stale = rowWidth(40, CELL_PX, probe, {
    boxCells: 40,
    rowsCells: 40,
    ...RUNG2_METRICS,
  }, 35)
  assert.deepEqual(stale, { W: 23, dynamic: true, rung: 2 })
  assert.equal(stale.accepted, undefined)

  const shrink = rowWidth(40, CELL_PX, probe, {
    boxCells: 30,
    rowsCells: 35,
    ...RUNG2_METRICS,
  }, 40)
  assert.deepEqual(shrink, { W: 23, dynamic: true, rung: 2 })
  assert.equal(shrink.accepted, undefined)

  const closed = rowWidth(
    40,
    CELL_PX,
    { ...probe, loaded: false },
    { boxCells: 40, rowsCells: 40 },
    40,
  )
  assert.deepEqual(closed, { W: 40, dynamic: false })
  assert.equal(closed.accepted, undefined)
})

test("T24 rung 1 wins, then the cap, the floor, and the dampener (C51, C46, C47, C53)", () => {
  const probe = { ...SIDE_PROBE, cssWidth: 360 }
  const agents = [memberRole("coder", "explore")]
  const sources = goSources([], agents)

  // The slot box is 50, the configured width caps it at 40.
  assert.deepEqual(selectCells(probe, { layoutCells: 50 }, CELL_PX), { cells: 50, rung: 1 })
  assert.deepEqual(
    rowWidth(40, CELL_PX, probe, { layoutCells: 50 }),
    { W: 40, dynamic: true, rung: 1, accepted: 40 },
  )
  assert.equal(
    dynamicPanel(sources, undefined, 40).rows[0].head,
    " 1.explore      Go/Kimi K3.1 Pro   ",
  )

  // The strict edge: A.width 36 vs rows 35 is the smallest accepted ancestor.
  assert.deepEqual(
    rowWidth(40, CELL_PX, probe, { layoutCells: 36, boxCells: 36, rowsCells: 35 }),
    { W: 36, dynamic: true, rung: 1, accepted: 36 },
  )

  // A narrower box narrows the row.
  assert.deepEqual(
    rowWidth(40, CELL_PX, probe, { layoutCells: 28 }),
    { W: 28, dynamic: true, rung: 1, accepted: 28 },
  )
  assert.equal(
    dynamicPanel(sources, undefined, 28).rows[0].head,
    " 1.explore Go/Kimi K3… ",
  )

  // The floor adopts 19, and the record is the adopted width (19, not 12).
  assert.deepEqual(
    rowWidth(40, CELL_PX, probe, { layoutCells: 12 }),
    { W: 19, dynamic: true, rung: 1, accepted: 19 },
  )

  // Dampener, two passes, same result: pass 1 wins rung 1 and records 40.
  const pass1 = rowWidth(
    40,
    CELL_PX,
    probe,
    { layoutCells: 40, boxCells: 40, rowsCells: 35, ...RUNG2_METRICS },
    undefined,
  )
  assert.deepEqual(pass1, { W: 40, dynamic: true, rung: 1, accepted: 40 })
  // Pass 2: the box now equals the rows, so no strict win; the record keeps it.
  const pass2 = rowWidth(
    40,
    CELL_PX,
    probe,
    { boxCells: 40, rowsCells: 40, ...RUNG2_METRICS },
    pass1.accepted,
  )
  assert.deepEqual(pass2, { W: 40, dynamic: true, rung: 1, accepted: 40 })

  // A stale record (not the rows' width) falls to rung 2 and clears.
  const stale = rowWidth(
    40,
    CELL_PX,
    probe,
    { boxCells: 40, rowsCells: 40, ...RUNG2_METRICS },
    35,
  )
  assert.deepEqual(stale, { W: 23, dynamic: true, rung: 2 })
  assert.equal(stale.accepted, undefined)

  // Shrink clears: a narrower box never wins and never keeps the record.
  const shrink = rowWidth(
    40,
    CELL_PX,
    probe,
    { boxCells: 30, rowsCells: 35, ...RUNG2_METRICS },
    40,
  )
  assert.deepEqual(shrink, { W: 23, dynamic: true, rung: 2 })
  assert.equal(shrink.accepted, undefined)

  // Equality without a record invents nothing: it falls to rung 2.
  const equalNoRecord = rowWidth(
    40,
    CELL_PX,
    probe,
    { boxCells: 35, rowsCells: 35, ...RUNG2_METRICS },
    undefined,
  )
  assert.deepEqual(equalNoRecord, { W: 23, dynamic: true, rung: 2 })
  assert.equal(equalNoRecord.accepted, undefined)

  // Provenance: `rowsCells` is P.width, never A.width. Rows shrank to 35 in an
  // unchanged 40-cell box; an implementation reading rowsCells from A.width
  // would see a stable box and wrongly keep 40.
  const rowsShrank = rowWidth(
    40,
    CELL_PX,
    probe,
    { boxCells: 40, rowsCells: 35, ...RUNG2_METRICS },
    40,
  )
  assert.deepEqual(rowsShrank, { W: 23, dynamic: true, rung: 2 })
  assert.equal(rowsShrank.accepted, undefined)

  // Ambiguity falls through to rung 3 with the T15 probe.
  assert.deepEqual(
    selectCells(SIDE_PROBE, { layoutCells: undefined, boxCells: 30, rowsCells: 35 }, CELL_PX),
    { cells: 35, rung: 3 },
  )
  assert.deepEqual(
    rowWidth(40, CELL_PX, SIDE_PROBE, { boxCells: 30, rowsCells: 35 }),
    { W: 35, dynamic: true, rung: 3 },
  )
  assert.equal(
    dynamicPanel(sources, undefined, 35).rows[0].head,
    " 1.explore    Go/Kimi K3.1 P… ",
  )

  // Rung 1 is asked before rung 2 at the same input.
  assert.deepEqual(
    selectCells(
      { ...SIDE_PROBE, cssWidth: 280 },
      { layoutCells: 40, resolutionWidth: 1600, rendererColumns: 200 },
      CELL_PX,
    ),
    { cells: 40, rung: 1 },
  )
})

test("T25 rung 2 versus rung 3, and which rung reads the option (C52, C46, C37)", () => {
  const probe = { ...SIDE_PROBE, cssWidth: 360 }

  // 360 / 16 = 22.5 rounds half-up to 23.
  assert.deepEqual(
    selectCells(probe, { resolutionWidth: 1600, rendererColumns: 100 }, CELL_PX),
    { cells: 23, rung: 2 },
  )
  const rung2 = rowWidth(50, CELL_PX, probe, {
    resolutionWidth: 1600,
    rendererColumns: 100,
  })
  assert.deepEqual(rung2, { W: 23, dynamic: true, rung: 2 })
  assert.equal(rung2.accepted, undefined)

  // No pixel resolution: rung 3 with the option's default 8.
  assert.deepEqual(
    rowWidth(50, CELL_PX, probe, { resolutionWidth: undefined, rendererColumns: 100 }),
    { W: 45, dynamic: true, rung: 3 },
  )

  // Option 10 with the resolution present: rung 2 never reads it.
  assert.deepEqual(
    rowWidth(50, 10, probe, { resolutionWidth: 1600, rendererColumns: 100 }),
    { W: 23, dynamic: true, rung: 2 },
  )
  // The same input without a resolution: rung 3 reads the option, 360 / 10 = 36.
  assert.deepEqual(
    rowWidth(50, 10, probe, { resolutionWidth: undefined, rendererColumns: 100 }),
    { W: 36, dynamic: true, rung: 3 },
  )

  // A zero column count skips rung 2 (no Infinity/NaN cell count).
  assert.deepEqual(
    rowWidth(50, CELL_PX, probe, { resolutionWidth: 1600, rendererColumns: 0 }),
    { W: 45, dynamic: true, rung: 3 },
  )
})

