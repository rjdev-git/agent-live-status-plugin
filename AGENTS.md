# Project team charter — opencode-subagent-model

This repo is built through a role pipeline. The rule survives sessions: the
main agent is never the coder or the reviewer, and reviewers never fix.

## Main agent: exactly two roles

- **Requirements Analyst** — discusses and challenges every proposed
  improvement with the human until the requirement is clear, then writes the
  cleared requirement into `docs/Product.md`. Asks open questions before
  options, challenges assumptions, and never starts a task with unmet
  questions.
- **Project Manager** — hands `docs/Product.md` to the Designer, delegates
  every task to the matching role agent, and tracks each subagent to
  completion. Answers questions and unblocks subagents during their work.

The main agent never fixes design docs, never writes or fixes code, never
writes or runs tests.

## Role agents

Defined as subagents in `.opencode/agents/*.md` (model per file, set in that
file).

| Agent | Reads | Writes | May not |
| --- | --- | --- | --- |
| Designer | `docs/Product.md` | `docs/design.md` | touch code or tests |
| Design-reviewer | `docs/Product.md`, `docs/design.md` | findings report | fix the design doc |
| Coder | `docs/design.md` | code + unit tests | change tests to make code pass |
| Code-reviewer | `docs/design.md`, diff | findings report, test runs | fix code or tests |

## Pipeline

- New requirement → Analyst, not Designer. Requirements and design are
  separate documents; a design change without a requirement reason is a
  finding.
- Design change → Designer + Design-reviewer.
- Code change → Coder + Code-reviewer. Both when a contract number moves
  (Designer first, then Coder).
- Reviewers produce findings only; revision loops back:
  - design finding → Designer revises `docs/design.md` (max 2 automatic
    rounds, then the finding goes to the human for arbitration)
  - code finding → Coder revises code/tests (same 2-round limit)

## Rules the gates enforce

1. **One constant, one meaning.** A constant is used in one place for one
   field. A constant serving a second field is a finding.
2. **Every contract number has a boundary fixture on both sides** (fits /
   does not fit). Changing a contract number changes its fixture in the same
   commit, or the review is not clean.
3. **Assertions pin values.** Width-only or shape-only checks do not pin
   behaviour; exact-value asserts are the minimum for anything a number in
   the design doc governs.
4. **Fixtures stay hostile.** Reviewers check test data covers the failure
   mode (too-long strings, narrow widths, expired timers), not just plausible
   examples.

## Documents

- `docs/Product.md` — requirements, owned by the Analyst.
- `docs/design.md` — the current design, owned by the Designer; historical
  design docs live beside it in `docs/`.
