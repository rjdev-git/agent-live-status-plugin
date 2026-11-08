import assert from "node:assert/strict"
import test from "node:test"
import {
  BAR_CELLS,
  BODY_MAX_LINES,
  DEFAULT_WIDTH,
  ELLIPSIS_CELLS,
  FILL_MAX_BOXES,
  FILL_MIN_BOXES,
  GRACE_MS,
  GRACE_TICK_MS,
  INSTANCE_FIXED_CELLS,
  INSTANCE_INDENT_CELLS,
  INSTANCE_MODEL_CELLS,
  INSTANCE_TITLE_CELLS,
  INSTANCE_TITLE_GAP_CELLS,
  PICKER_AGENT_CELLS,
  PICKER_MODEL_CELLS,
  PROVIDER_MAX_SHARE,
  ROLE_FIXED_CELLS,
  ROLE_MODEL_MAX_CELLS,
  ROLE_NAME_CELLS,
  ROLE_NAME_GAP_CELLS,
  ROLE_NUMBER_CELLS,
  ROLE_NUMBER_DIGITS,
  TPS_PER_BOX,
  UNKNOWN_MODEL,
  barFill,
  barTone,
  cellWidth,
  cleanTitle,
  clip,
  collect,
  elapsed,
  fitModel,
  filterRows,
  labeler,
  isVisibleRole,
  panel,
  matches,
  pickerTitle,
  resolveModel,
  speedTps,
  type AgentInfo,
  type RunningSubagent,
  type SessionInfo,
  type SessionSource,
  type Sources,
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
): Sources {
  return {
    sessions: fakeSessions([{ id: "root" }, ...sessions], running, messages),
    agents,
    models,
    providers,
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

test("instance rows show an 8-cell title and a 13-cell model", () => {
  const NOW = 1_000_000
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
    agents: [{ id: "aa", name: "Alpha", mode: "subagent", model: { id: "deepseek-flash", providerID: "deepseek" } }],
    models,
    providers,
  }

  const view = panel(sources, "root", 35, 10, NOW)
  const instance = view.rows.find((row) => row.head.startsWith(" └"))!
  assert.equal(instance.head, " └ Inspect… Deep…/DeepSe…     ")
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
  const sources: Sources = { sessions: fakeSessions([]), agents }
  const view = panel(sources, undefined, 35, 10, 0)
  assert.equal(view.rows.length, 10)
  assert.equal(view.more, 2)
  assert.equal(view.rows[0].head, " 1.Agent0                     ")
})

test("panel falls back to the agent or session model for the role row", () => {
  const agents = [{ id: "alpha", name: "Alpha", mode: "subagent", model: { id: "deepseek-flash", providerID: "deepseek" } }]
  const sources: Sources = { sessions: fakeSessions([]), agents, models, providers }
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
  return {
    sessions: fakeSessions([{ id: "root" }]),
    agents: [agent("a", "A", { model: { id: "m", providerID: "p" } })],
    models: [{ id: "m", modelID: "m", providerID: "p", name: modelName }],
    providers: [{ id: "p", name: providerName }],
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
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }]),
    agents: [agent("explore", "explore", { model: { id: "kimi", providerID: "go" } })],
    models: [{ id: "kimi", modelID: "kimi", providerID: "go", name: "Kimi K3.1 Pro" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
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
  const twenty = panel(roleWithModel("P", "123456789012345678"), undefined, 39, BODY_MAX_LINES, 0)
  assert.equal(twenty.rows[0].head.slice(13, 33), "P/123456789012345678")

  const twentyOne = panel(roleWithModel("P", "1234567890123456789"), undefined, 39, BODY_MAX_LINES, 0)
  assert.equal(twentyOne.rows[0].head.slice(13, 33), "P/12345678901234567…")
})

test("C8 ROLE_FIXED_CELLS = 18 leaves the model column and raises narrow widths", () => {
  assert.equal(ROLE_FIXED_CELLS, 18)
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
    agents: [agent("a", "A")],
    models: [{ id: "grok47", modelID: "grok47", providerID: "go", name: "Grok 4.7" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
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
  const session = { ...role.sessions[0], title: "abcdefghi" }
  const view = panel(rootSources([session], [role.agent], role.running), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[1].head.slice(3, 11), "abcdefg…")
})

test("C12 INSTANCE_TITLE_GAP_CELLS = 1 after the title field", () => {
  assert.equal(INSTANCE_TITLE_GAP_CELLS, 1)
  const role = runningRole("aa", "Alpha", 1, 100)
  const session = { ...role.sessions[0], title: "abcdefghi" }
  const view = panel(rootSources([session], [role.agent], role.running), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[1].head[11], " ")
  assert.equal(view.rows[1].head.slice(3, 11), "abcdefg…")
})

test("C13 INSTANCE_MODEL_CELLS = 13 uses the split rule", () => {
  assert.equal(INSTANCE_MODEL_CELLS, 13)
  assert.equal(fitModel("OpenCode/Kimi K3.1 Pro", 13), "Open…/Kimi K…")
  assert.equal(clip("OpenCode/Kimi K3.1 Pro", 13), "OpenCode/Kim…")
  assert.notEqual(fitModel("OpenCode/Kimi K3.1 Pro", 13), clip("OpenCode/Kimi K3.1 Pro", 13))

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
    agents: [agent("a", "A")],
    models: [{ id: "kimi-k31", modelID: "kimi-k31", providerID: "opencode", name: "Kimi K3.1 Pro" }],
    providers: [{ id: "opencode", name: "OpenCode" }],
  }
  const view = panel(sources, "root", 35, BODY_MAX_LINES, 0)
  assert.equal(view.rows[1].head.slice(12, 30), "Open…/Kimi K…     ")
  assert.equal(cellWidth(view.rows[1].head.slice(12, 30)), 18)
})

test("C14 INSTANCE_FIXED_CELLS = 17 leaves the model column", () => {
  assert.equal(INSTANCE_FIXED_CELLS, 17)
  const role = runningRole("aa", "Alpha", 1, 100)
  const wide = panel(rootSources(role.sessions, [role.agent], role.running), "root", 35, BODY_MAX_LINES, 0)
  assert.equal(cellWidth(wide.rows[1].head.slice(12, 30)), 18)

  const narrow = panel(rootSources(role.sessions, [role.agent], role.running), "root", 18, BODY_MAX_LINES, 0)
  assert.equal(cellWidth(narrow.rows[1].head), 14)
  assert.equal(cellWidth(narrow.rows[1].head.slice(12, 14)), 2)
})

test("C15 tight boxes: the model column ends where the boxes start", () => {
  const roleSources: Sources = {
    sessions: fakeSessions([{ id: "root" }]),
    agents: [agent("a", "A", { model: { id: "grok47f", providerID: "go" } })],
    models: [{ id: "grok47f", modelID: "grok47f", providerID: "go", name: "Grok 4.7 Flash" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
  }
  const roleHead = panel(roleSources, undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(roleHead.slice(13, 30), "Go/Grok 4.7 Flash")
  assert.equal(cellWidth(roleHead.slice(13, 30)), 17)
  // A gap cell would shrink the column to 16 and clip the label.
  assert.notEqual(roleHead.slice(13, 30), "Go/Grok 4.7 Fla…")

  const instanceSources: Sources = {
    sessions: fakeSessions(
      [
        { id: "root" },
        {
          id: "g",
          parentID: "root",
          agent: "a",
          title: "x",
          model: { id: "grok471", providerID: "go" },
          time: { created: 100 },
        },
      ],
      ["g"],
    ),
    agents: [agent("a", "A")],
    models: [{ id: "grok471", modelID: "grok471", providerID: "go", name: "Grok 4.7.1" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
  }
  const instanceHead = panel(instanceSources, "root", 35, BODY_MAX_LINES, 0).rows[1].head
  assert.equal(instanceHead.slice(12, 30), "Go/Grok 4.7.1     ")
  assert.equal(instanceHead.slice(12, 25), "Go/Grok 4.7.1")
  // A gap cell would shrink the text budget to 12 and clip the label.
  assert.notEqual(instanceHead.slice(12, 25), "Go/Grok 4.7…")
})

test("F21 above width 35 the instance text stays 13 cells and the column pads", () => {
  const at = (id: string, modelName: string) => {
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
      agents: [agent("a", "A")],
      models: [{ id, modelID: id, providerID: "go", name: modelName }],
      providers: [{ id: "go", name: "OpenCode Go" }],
    }
    return panel(sources, "root", 39, BODY_MAX_LINES, 0).rows[1].head
  }

  // Width 39: instance column 22, but the text cap stays 13, so the other 9
  // cells are padding and the boxes stay tight at column W-4 (F21, C13/C14).
  const head = at("grok471", "Grok 4.7.1")
  assert.equal(head, " └ x        Go/Grok 4.7.1         ")
  assert.equal(cellWidth(head), 39 - BAR_CELLS)
  assert.equal(head.length, 39 - BAR_CELLS)
  assert.equal(head.slice(12, 25), "Go/Grok 4.7.1")
  assert.equal(head.slice(25, 39 - BAR_CELLS), " ".repeat(9))
  assert.equal(head.slice(25, 39 - BAR_CELLS).trim(), "")
  assert.equal(cellWidth(head) + BAR_CELLS, 39)

  // Does not fit the 13-cell text cap: the 22-cell column has room, but the
  // text still clips at 13. A wider-text implementation (column-sized text)
  // would keep the 17-cell label whole, and a short column (12 cells) would
  // clip one cell earlier.
  const long = at("grok471pro", "Grok 4.7.1 Pro")
  assert.equal(long.slice(12, 25), "Go/Grok 4.7.…")
  assert.notEqual(long.slice(12, 25), "Go/Grok 4.7.1")
  assert.notEqual(long.slice(12, 25), "Go/Grok 4.7…")
  assert.equal(cellWidth(long), 39 - BAR_CELLS)
  assert.equal(long.slice(25, 39 - BAR_CELLS), " ".repeat(9))
  assert.equal(cellWidth(long) + BAR_CELLS, 39)
})

test("C16 FILL_MIN_BOXES = 0 clamps the lower edge", () => {
  assert.equal(FILL_MIN_BOXES, 0)
  assert.equal(barFill(0), 0)
  assert.equal(barFill(9), 0)
  assert.equal(barFill(-1), 0)
})

test("C17 FILL_MAX_BOXES = 5 clamps the upper edge", () => {
  assert.equal(FILL_MAX_BOXES, 5)
  assert.equal(barFill(1000), 5)
  assert.equal(barFill(89), 4)
})

test("C18 TPS_PER_BOX = 20 fills one box", () => {
  assert.equal(TPS_PER_BOX, 20)
  assert.equal(barFill(20), 1)
  assert.equal(barFill(19), 1)
  // 29 still needs 30 for two boxes.
  assert.equal(barFill(29), 1)
})

test("C19 the fill formula is half-up and clamped", () => {
  assert.equal(barFill(10), 1)
  assert.equal(barFill(30), 2)
  assert.equal(barFill(50), 3)
  assert.equal(barFill(90), 5)
  assert.equal(barFill(9), 0)
  assert.equal(barFill(29), 1)
  assert.equal(barFill(89), 4)
  assert.equal(barFill(undefined), 0)
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
  assert.equal(barTone(barFill(10)), "success")
  assert.equal(barTone(barFill(300)), "success")
  // Five boxes never take a warning or error tone.
  assert.equal(barTone(barFill(1000)), "success")
  assert.equal(barTone(barFill(undefined)), "muted")
  for (const filled of [0, 1, 2, 3, 4, 5]) {
    const tone = barTone(filled)
    assert.equal(tone === "success" || tone === "muted", true)
    assert.notEqual(tone, "warning")
    assert.notEqual(tone, "error")
  }
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
  assert.equal(fitModel("Go/MiniMax M3.1 Flash", 16), "Go/MiniMax M3.1…")
  assert.equal(fitModel("SomeVeryBigName/Model", 16), "SomeVe…/Model")
})

test("C27 UNKNOWN_MODEL is the last resolution fallback", () => {
  assert.equal(UNKNOWN_MODEL, "unknown model")
  const sources: Sources = { sessions: fakeSessions([{ id: "s1" }]) }
  assert.equal(resolveModel(sources.sessions.list()[0], sources), "unknown model")

  const unknown = (width: number) =>
    panel(rootSources([child("u", "aa", 100)], [agent("aa", "Alpha")], ["u"]), "root", width, BODY_MAX_LINES, 0)
  // Width 30 leaves a 13-cell instance column, so the whole text fits.
  assert.equal(unknown(30).rows[1].head.slice(12, 25), "unknown model")
  // Width 29 leaves a 12-cell column, so it clips.
  assert.equal(unknown(29).rows[1].head.slice(12, 24), "unknown mod…")
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
  }

  const view = panel(sources, "root", 35, BODY_MAX_LINES, NOW)
  assert.equal(view.rows[0].tps, 60)
  assert.equal(view.rows[0].filled, 3)
  assert.equal(view.rows[1].tps, 20)
  assert.equal(view.rows[1].filled, 1)
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
  const sources: Sources = {
    sessions: fakeSessions([{ id: "root" }]),
    agents: [agent("explore", "explore", { model: { id: "kimi", providerID: "go" } })],
    models: [{ id: "kimi", modelID: "kimi", providerID: "go", name: "Kimi K3.1 Pro" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
  }
  const head = panel(sources, undefined, 35, BODY_MAX_LINES, 0).rows[0].head
  assert.equal(head, " 1.explore   Go/Kimi K3.1 Pro ")
  assert.equal(cellWidth(head), 30)
})

test("instance row at width 35 pads the model column", () => {
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
    agents: [agent("a", "A")],
    models: [{ id: "grok47", modelID: "grok47", providerID: "go", name: "Grok 4.7" }],
    providers: [{ id: "go", name: "OpenCode Go" }],
  }
  const head = panel(sources, "root", 35, BODY_MAX_LINES, 0).rows[1].head
  assert.equal(head, " ├ Inspect… Go/Grok 4.7       ")
  assert.equal(cellWidth(head), 30)
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
