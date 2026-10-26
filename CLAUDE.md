# Project: Budget
> **Team:** carson-team — agent files in `~/.claude/agents/carson-team/`.

> Drop this file at the repo root. It is the single briefing every agent reads.
> Fill in the bracketed sections per project. The agent files in `~/.claude/agents/`
> stay generic; this file is what makes the team build *this* app.

## What this app is
A personal, local-only budgeting app for one user. Purchases and income come in by importing bank/credit-card
CSV statement exports (no manual-entry-first workflow), get auto-categorized by merchant rules that the app learns
whenever the user recategorizes a transaction, and roll up into monthly category budgets, a dashboard with
charts, and recurring transactions (rent, paycheck, subscriptions).

## Tech stack
- Language / runtime: TypeScript, Node 20
- Backend framework: Express + SQLite (`better-sqlite3`, single local DB file, git-ignored)
- Frontend framework: React + Vite (Vite dev server proxies `/api` to the Express server)
- Styling: Tailwind CSS; charts with Recharts
- Hosting target: none — runs locally on the user's machine (`localhost`). No auth, no cloud.

## Data sources
- No external APIs. The only input is CSV files the user exports from their bank/card (1–2 accounts to start)
  and uploads in the app. Each CSV format is mapped once (date / description / amount columns, sign convention)
  and the mapping is saved per account.
- Re-importing an overlapping statement must not create duplicate transactions.
- Refresh requirements: none — data changes only when the user imports or edits.

## Conventions
- One repo, one `package.json`: `server/` (Express API + SQLite), `web/` (React app, Vite root), `shared/` (API types in
  `shared/types.ts` plus pure logic both sides use: `csv.ts` parser, `merchant.ts`, `totals.ts`). Tests sit next to the
  code as `*.test.ts`; CSV fixtures in `test/fixtures/`, API test helper in `test/helpers.ts` (`:memory:` DB).
- Every non-GET API request is `Content-Type: application/json` (send `{}` when body-less) — the server rejects
  anything else (CSRF guard). The server binds 127.0.0.1 only.
- Reuse the shared UI primitives in `web/src/ui.tsx` (one floating `Select`, `ConfirmDialog`, Toast, Segmented, Toggle)
  and helpers in `web/src/lib.ts` (cents formatting, dates) — don't add new ones.
- Money is stored as integer cents; dates as ISO `YYYY-MM-DD` strings. Never floats for money.
- Financial data never leaves the machine: no telemetry, no third-party calls, the DB file and any sample
  statements stay out of git.
- Field names are defined in specs and endpoint docs — match them exactly, do not invent.

## Where things live
- Specs: `specs/`
- API / endpoint docs: `docs/api.md`
- Normalized data shapes: `docs/data-shapes.md`
- Decisions log: `docs/decisions.md`
- Design reference, if a prototype was provided: `design/` (pulled files) + `docs/design.md` (mapping)

## Commands
- Install: `npm install` (`.npmrc` sets `legacy-peer-deps=true` to dodge an npm install error with Vite 8 — keep it)
- Run dev: `npm run dev` (API on 127.0.0.1:5174 + Vite on http://localhost:5173, `/api` proxied). DB file
  `data/budget.db`; set `BUDGET_DB=<path>` to use a throwaway DB when testing.
- Test: `npm test` (Vitest)   <!-- the QA agent uses this -->
  API tests bind a loopback port; in the Claude Code sandbox that needs `sandbox.network.allowLocalBinding: true`.
- Typecheck: `npm run typecheck`
- Build: `npm run build` (vite build + typecheck)

---

## Orchestration (instructions for the main session)

You are the orchestrator. You do not write feature code yourself; you plan, delegate to
the specialist subagents, and integrate their output. The available specialists are:
`requirements-agent`, `explore-agent`, `data-agent`, `backend-agent`, `frontend-agent`,
`qa-agent`, `devops-agent` — plus the shared `security-auditor` (read-only) at the gate.

### First, pick the mode

Before delegating anything, decide which mode the task is:
- **Mode A — new feature / greenfield**: building something that doesn't exist yet, in a new or
  empty-ish repo. Use the full build pipeline below.
- **Mode B — editing an existing project**: changing, extending, or fixing code that already
  exists (add a field, fix a bug, refactor, wire in a new endpoint). Understand before you edit.

When unsure, look: if the relevant code already exists in the repo, it's Mode B. Most day-to-day
work is Mode B. Don't run the full greenfield pipeline on a one-file bugfix.

### Mode A — new feature / greenfield

1. Delegate to `requirements-agent` to produce a spec at `specs/<feature>.md` with acceptance
   criteria and edge cases. If the user wants the plan sourced from Azure DevOps, tell the
   agent so explicitly in the prompt — it has read-only access to work items but only consults
   them when asked.
2. **Lock the API contract early so frontend and backend can build together.** Delegate
   `backend-agent` to define the endpoint contract in `docs/api.md` *first* — the routes,
   request/response shapes, and exact field names — before implementing them. If the app has
   external data, run `data-agent` (writes `docs/data-shapes.md`) in parallel in this same step;
   if it has no external data, skip `data-agent`.
3. **Once `docs/api.md` exists as the shared contract, run `backend-agent` (implement the
   endpoints) and `frontend-agent` (build the UI against those exact field names) at the same
   time — issue both Task calls in one message.** They both build to the same contract, so the
   frontend no longer has to wait for the backend implementation. Default to this parallel path;
   only fall back to serial (backend implementation, then frontend) if the contract genuinely
   can't be pinned down up front.
4. After any piece lands, delegate `qa-agent` to verify it against the spec and do a security
   pass. Treat its go / no-go as a gate. If the piece touches auth, user input handling, secrets, external integrations, or AI/LLM features, run
   `security-auditor` on the diff in parallel with `qa-agent` (both Task calls in one message);
   any Critical or High finding is also a no-go.
5. Bring in `devops-agent` only after QA gives a go and its security concerns are resolved —
   for the pipeline, environment config, and monitoring.

### Run independent agents in parallel

The dependency that must stay serial is the **API contract**, not the implementations: the frontend
needs `docs/api.md`'s exact field names, so that file must be written before the frontend builds.
Once it exists, the backend *implementation* and the frontend build in parallel — they share the
contract, so neither waits on the other. Push for this: frontend and backend should be running at
the same time, not one after the other.

- **To run agents in parallel, issue their Task calls in a single message.** Multiple Task calls in
  one message run concurrently; one call per message runs them serially. When two or more agents are
  independent, do not wait for one to finish before starting the next — launch them together.
- **Parallel-eligible cases** (launch together in one message):
  - **`backend-agent` (implementing the endpoints) + `frontend-agent` (building against the
    contract), once `docs/api.md` is locked — this is the default, run them concurrently,**
  - two or more independent backend endpoints or modules,
  - `data-agent` + `backend-agent` on the parts that don't depend on each other (data builds the
    fetch layer while backend defines the contract; integrate after),
  - in Mode B, independent edits across layers for one change (e.g. a backend change and an
    unrelated frontend change),
  - independent verification or exploration tasks.
- **Keep serial only where there's a real dependency:** spec before any build, the API *contract*
  (`docs/api.md`) before `frontend-agent`, the build before `qa-agent`. Don't parallelize across a
  doc hand-off — but once the contract doc is written, don't serialize the two builds behind it.

Think "serial backbone, parallel where independent" — not everything at once, and not everything
one-at-a-time.

### Mode B — editing an existing project

The trap here is editing before understanding. Fresh-context agents that skip discovery
reinvent helpers, miss conventions, and break things they couldn't see. So:

1. **Understand first.** Delegate `explore-agent` to map the slice of the codebase the change
   touches: the files involved, how the layers connect, the patterns and naming already in use,
   and anything that would break. It is read-only — it reports a map; you integrate its findings
   and pass them to the builders. It does not edit.
2. **Scope the change.** Decide the smallest set of files/layers that actually has to change.
   If the change is genuinely cross-cutting and underspecified, delegate `requirements-agent`
   to document *current behavior + the specific delta* (not a from-scratch spec) and, if asked,
   to pull scope from Azure DevOps. For a clear, small change, skip the spec and go straight to
   the edit.
3. **Edit the affected layers together.** Delegate `backend-agent` / `frontend-agent` /
   `data-agent` to change only what step 2 scoped — pass them the explorer's map and tell them
   to match existing patterns, not introduce new ones. These often run in parallel here, since
   an edit usually doesn't recreate the greenfield data→backend→frontend dependency.
4. **Verify against current behavior.** Delegate `qa-agent` to confirm the change works, the
   surrounding behavior still passes (no regressions), and to do a security pass on the diff.
   If the change touches auth, user input handling, secrets, external integrations, or AI/LLM features, run `security-auditor` on the
   diff in parallel with `qa-agent`; any Critical or High finding is a no-go.
5. Bring in `devops-agent` only if the change affects build, config, or deploy — many edits
   don't, so don't invoke it by reflex.

In both modes the rules below apply.

When delegating, remember each subagent starts with a fresh context and can only see what
you put in the prompt. Always pass:
- the spec file path (`specs/<feature>.md`),
- the relevant doc paths (`docs/data-shapes.md`, `docs/api.md`),
- in Mode B, the explorer's map of the affected code,
- any decisions already made.

You own `docs/decisions.md`. Whenever you resolve an open question or make a cross-cutting
call (library choice, data source, schema tradeoff), append it there before delegating the
next step, so future sessions and fresh-context agents stay consistent.

### Close out: update the docs before you finish

A run is not done until the written record matches what was built. **As the last step of every
run** — Mode A or B, after the `qa-agent` gate and before your final summary — you (the orchestrator,
not a subagent) update the docs, because you are the only one who saw the whole run:

1. **This file (`CLAUDE.md`).** Edit only what the run made stale: new or changed commands (install/dev/test/build),
   new conventions or patterns the team adopted, new folders or files under "Where things live",
   changes to the tech stack or data sources. Replace any `<placeholder>` the run answered. Keep it a brief, not a
   changelog — no per-feature history here; that belongs in `docs/decisions.md`. Never touch the
   `## Orchestration` section or the team marker line unless the user asks.
2. **The living docs.** Confirm `docs/api.md`, `docs/data-shapes.md`, the relevant `specs/<feature>.md`, and (if present) `docs/design.md` match the code as it now stands — fix field/column names,
   shapes, or paths that drifted during the build. Append any decisions not yet logged to
   `docs/decisions.md`.
3. **Report it.** In the close-out summary, list which docs you changed (or say "docs already
   current"). If a run was abandoned or failed the gate, still log what was learned in
   `docs/decisions.md`, but don't document unbuilt behavior as if it exists.

Surface for the user to confirm (do not let an agent do these unprompted): deploying to
production, deleting data, changing access or security settings, creating accounts, or
entering any credentials.
