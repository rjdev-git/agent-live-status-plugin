import assert from "node:assert/strict"
import test from "node:test"
import {
  cleanTitle,
  collect,
  contextPct,
  elapsed,
  fitModel,
  filterRows,
  labeler,
  panel,
  layout,
  matches,
  resolveModel,
  summary,
  truncate,
  type RunningSubagent,
  type SessionInfo,
  type SessionSource,
  type Sources,
} from "./collect.ts"

function fakeSessions(
  sessions: SessionInfo[],
  running: string[] = [],
  messages: Record<string, Array<{ tokens?: { input: number; cache?: { read?: number } } }>> = {},
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

test("contextPct uses the newest usage over the model context limit", () => {
  const sources: Sources = {
    sessions: fakeSessions(
      [{ id: "child", parentID: "root", model: { id: "deepseek-flash", providerID: "deepseek" } }],
      ["child"],
      { child: [{ tokens: { input: 10 } }, { tokens: { input: 100_000, cache: { read: 28_000 } } }] },
    ),
    models: [{ ...models[0], limit: { context: 256_000 } }],
    providers,
  }
  const row = collect(sources)[0]
  assert.equal(Math.round(row.pct!), 50)
  assert.equal(row.modelShort, "DeepSeek/DeepSeek Flash")
  assert.equal(contextPct(sources.sessions.list()[0], sources), 50)
})

test("contextPct is unknown without a usage or a model limit", () => {
  const base = { id: "child", model: { id: "deepseek-flash", providerID: "deepseek" } }
  const noLimit: Sources = {
    sessions: fakeSessions([base], [], { child: [{ tokens: { input: 1_000 } }] }),
    models,
  }
  assert.equal(contextPct(noLimit.sessions.list()[0], noLimit), undefined)

  const noUsage: Sources = {
    sessions: fakeSessions([base]),
    models: [{ ...models[0], limit: { context: 256_000 } }],
  }
  assert.equal(contextPct(noUsage.sessions.list()[0], noUsage), undefined)
})

test("contextPct never exceeds 100", () => {
  const sources: Sources = {
    sessions: fakeSessions(
      [{ id: "child", model: { id: "deepseek-flash", providerID: "deepseek" } }],
      [],
      { child: [{ tokens: { input: 300_000 } }] },
    ),
    models: [{ ...models[0], limit: { context: 256_000 } }],
  }
  assert.equal(contextPct(sources.sessions.list()[0], sources), 100)
})

test("layout numbers rows oldest first and pads the columns", () => {
  const rows: RunningSubagent[] = [
    {
      sessionID: "b",
      agent: "general",
      model: "OpenCode Go/MiniMax M3.1 Flash (high)",
      modelShort: "Go/MiniMax M3.1 Flash",
      title: "t",
      since: 2,
      pct: 12,
    },
    {
      sessionID: "a",
      agent: "explore",
      model: "OpenCode Go/Kimi K3.1 Pro (high)",
      modelShort: "Go/Kimi K3.1 Pro",
      title: "t",
      since: 1,
      pct: 62,
    },
  ]

  const result = layout(rows, 40, 9)
  assert.equal(result.rows[0].head, " 1.explore   Go/Kimi K3.1 Pro     ")
  assert.equal(result.rows[0].filled, 3)
  assert.equal(result.rows[1].head, " 2.general   Go/MiniMax M3.1 Fla… ")
  assert.equal(result.rows[1].filled, 1)
  assert.equal(result.rows[0].head.length + 5, 39)
  assert.equal(result.more, 0)
})

test("layout clips the model budget and counts rows past the cap", () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({
    sessionID: `s${index}`,
    agent: "a-very-long-agent-name",
    model: "OpenCode Go/An Extremely Long Model Name",
    modelShort: "Go/An Extremely Long Model Name",
    title: "t",
    since: index,
    pct: 100,
  }))

  const result = layout(rows, 40, 9)
  assert.equal(result.rows.length, 9)
  assert.equal(result.more, 2)
  assert.equal(result.rows[0].head, " 1.a-very-l… Go/An Extremely Lon… ")
  assert.equal(result.rows[0].filled, 5)
  assert.equal(result.rows[0].head.length + 5, 39)
})

test("layout leaves the boxes empty when the percentage is unknown", () => {
  const result = layout(
    [{ sessionID: "a", agent: "explore", model: "Go/Kimi", modelShort: "Go/Kimi", title: "t" }],
    40,
    9,
  )
  assert.equal(result.rows[0].filled, 0)
  assert.equal(result.rows[0].pct, undefined)
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

test("summary stays empty with no rows and names the agent for one row", () => {
  assert.equal(summary([]), "")
  assert.equal(
    summary([{ sessionID: "a", agent: "explore", model: "DeepSeek/Flash", title: "t" }]),
    "sub explore · DeepSeek/Flash",
  )
})

test("summary groups repeated models and distinct agents", () => {
  const rows = [
    { sessionID: "a", agent: "explore", model: "DeepSeek/Flash", title: "t" },
    { sessionID: "b", agent: "explore", model: "DeepSeek/Flash", title: "t" },
    { sessionID: "c", agent: "general", model: "OpenAI/GPT", title: "t" },
  ]
  assert.equal(summary(rows), "sub 3 · explore x2, general · DeepSeek/Flash x2, OpenAI/GPT")
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
  const sources: Sources = {
    sessions: fakeSessions(
      [
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

  const view = panel(sources, undefined, 35, 10, NOW)
  const instance = view.rows.find((row) => row.head.startsWith(" ├"))!
  assert.match(instance.head, /^ ├ Inspect… DeepS/)
  assert.equal(instance.head.length + 5, 35)
})

test("elapsed buckets seconds, minutes, and hours", () => {
  assert.equal(elapsed(undefined), "")
  assert.equal(elapsed(1_000, 43_000), "42s")
  assert.equal(elapsed(0, 43_000), "")
  assert.equal(elapsed(1_000, 181_000), "3m")
  assert.equal(elapsed(1_000, 3_721_000), "1h 2m")
})

test("truncate adds an ellipsis only when it has to", () => {
  assert.equal(truncate("abc", 5), "abc")
  assert.equal(truncate("abcdef", 4), "abc…")
  assert.equal(truncate("abc", 0), "")
  assert.equal(truncate("abc", 1), "…")
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
      ["active", "#00ff00"],
      ["active", "#00ff00"],
      ["grace", undefined],
      ["grace", undefined],
    ],
  )
  assert.match(view.rows[0].head, /^ 1\.Alpha/)
  assert.match(view.rows[1].head, /^ └ Doing w/)
  assert.match(view.rows[2].head, /^ 2\.Zeta /)
  assert.equal(view.rows[0].filled, 0)
  for (const row of view.rows) assert.equal(row.head.length + 5, 35)
  assert.equal(view.rows[1].head.length + 5, 35)
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

test("filterRows matches agent, model, and title case-insensitively", () => {  const rows = [
    { sessionID: "ses_1", agent: "explore", model: "DeepSeek/Flash", title: "Inspect repo" },
    { sessionID: "ses_2", agent: "general", model: "OpenAI/GPT", title: "Write tests" },
  ]
  assert.equal(filterRows(rows, "EXPLORE").length, 1)
  assert.equal(filterRows(rows, "gpt")[0].sessionID, "ses_2")
  assert.equal(filterRows(rows, "tests")[0].sessionID, "ses_2")
  assert.equal(filterRows(rows, "   ").length, 2)
})

test("matches spans every field and ignores case and padding", () => {
  assert.equal(matches("EXPLORE", "explore · DeepSeek/Flash", "Inspect repo"), true)
  assert.equal(matches(" ses_2 ", "general · OpenAI/GPT", "Write tests", "ses_2"), true)
  assert.equal(matches("missing", "general · OpenAI/GPT"), false)
  assert.equal(matches(undefined, "anything"), true)
  assert.equal(matches("", "anything"), true)
})
