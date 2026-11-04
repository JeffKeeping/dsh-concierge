# dsh-concierge roadmap

One order, oldest to newest. Each section states what shipped and what proves it.

- [v1 — the trunk](#v1--the-trunk)
- [v2 — Sources](#v2--sources)
- [v3 — hardening, assessment, GitHub](#v3--hardening-assessment-github)
- [v4 — deferred retry and the in-app panel](#v4--deferred-retry-and-the-in-app-panel)
- [Not planned](#not-planned)

---

## v1 — the trunk

A two-layer orchestration: the operator talks to a Router, each Ticket gets one worker
Session in its own directory, and a watchdog checks whether work actually advances.

- `superagent_ask` / `superagent_send` / `superagent_read` / `superagent_report`
- One worker Session per Ticket, working in `<stateDir>/agent/<ticket-id>`
- Worker slots (default 3) with a queue behind them
- A watchdog that fails a worker on repeated non-progress, not on a dead process
- SQLite for every Ticket, message and reference, so a restart resumes work
- One notification per terminal report; progress coalesced

Proved by `test/trunk.mjs`, `test/routing.mjs`, `test/watchdog.mjs`, `test/notify.mjs`.

## v2 — Sources

Events now arrive from outside, not only from the operator.

- `SourceKind` protocol following the reference cookbook: a kind is code, an instance is a
  row with its own read position and bot identity
- `trigger_event` with the event id as the idempotency key
- `subscription(ticket_id, thread_key)`, genuinely many-to-many; fan-out delivers to a
  worker without Router assessment
- Cursors commit once per round, after every event is stored, so an interrupted round
  replays instead of losing or double-counting
- Every refused event is recorded with a reason; nothing is dropped silently
- The Channel write side: ordered per Thread, retried 5s→300s, dropped only when the
  destination can never receive it

Proved by `test/sources.mjs`, `test/cli.mjs`.

## v3 — hardening, assessment, GitHub

### Step 0 — hardening, before any new capability

1. **External text isolation** (`lib/untrusted.js`): every Trigger text reaching a Router
   or a worker carries one fixed sentence, written into the stored text so it survives
   blob spill and truncation; `meta` also carries a machine-readable `untrusted: true`.
2. **Tool identity** (`lib/identity.js`): `ask`/`send` are Router-only, `report` requires
   the exact worker of that ticket, `read` confines a worker to its own ticket's
   references. Fixed refusal codes.
3. **Blocked limit** (`blockedRetries`, default 3): a ticket that keeps blocking is closed
   as failed with the streak recorded; `progress` resets it.
4. **Token custody** (`lib/secrets.js`): `--token-file` / `--token-env`; SQLite keeps a
   fingerprint only, the value is read at request time, an unreadable source fails closed.

### Step 1 — two-level semantic filtering

`lib/assess.js` sits above the gate and only ever narrows it: `assess` re-runs the gate
before any verdict counts, so a model that answers `accept` for a refused sender is
recorded as `ignore`. Unaddressed Triggers with no live Thread queue for assessment;
directly addressed ones and live Threads skip it. Decisions are stored with verdict,
reason and policy revision, and replay reads the stored verdict.

### Step 2 — chain recall and per-producer spill

`ref_edge` records derivation; `superagent_read(ref, follow, hops)` walks up to four hops
from a report to the inputs it cited. `ContextSpill` keeps the Router's inline history
bounded per producer, replacing aged-out entries with references while keeping their
summaries.

### Step 3 — the GitHub Source

Notifications become Triggers with stable ids; the account's own events are dropped; a
followed pull request that is merged or closed closes its Thread's Tickets, recorded once
in `thread_closure`. `threadContext.read` fetches the body and comments for assessment.

Proved by `test/hardening.mjs`, `test/assess.mjs`, `test/github.mjs`, `test/route.mjs`,
`test/migration.mjs`.

## v4 — deferred retry and the in-app panel

- **Deferred assessments retry.** A failed or unusable assessment is rescheduled with
  exponential backoff from `deferBaseMs` (15 minutes, doubling, capped at one day). At
  `maxDeferrals` (3) the layer stops guessing and records `ignore` with the whole streak in
  the reason. The schedule is `semantic_decision.next_at` in SQLite, so a restart resumes
  the wait instead of restarting it. `progress`-style recovery is not involved: a later
  successful attempt decides normally and keeps its attempt history.
- **A read-only panel in the app**, laid out after the installed context-insights plugin:
  title row with a range switch, six KPI cards, a collapsible chart area, then the ticket
  list, with Source health, semantic decisions and the delivery queue collapsed below.
  Charts are hand-drawn SVG (a donut is `strokeDasharray` on a circle), so no chart library
  is involved.
  - The whole panel is Chinese; the database keeps its English codes and `client.js` maps
    them at render time, so stored history stays readable.
  - A tester's smoke tickets are classified and kept behind a 测试 filter, never mixed with
    real work.
  - One aggregation endpoint (`GET /api/concierge/panel?range=…`) serves the whole panel
    over `ctx.connection.fetch` — same origin, existing credential, no extra port. It must
    live under `/api`, or the page falls through to the SPA router and reports a 404.
  - The banner is dismissible and the choice persists; with nothing to do, the attention
    KPI greys out and the list says 没有需要你处理的事.

### v4 fixes

- **The Router preset.** The division-of-labour problem: a general-purpose session, told to
  build a website, builds it. `lib/preset.js` registers a `concierge-router` agent preset
  whose prompt says it does not execute and whose tool set has no shell, no write and no
  subagent. Registering is idempotent and never overwrites a preset the operator already
  declared under that id — it reports the conflict instead. New sessions can select it;
  existing sessions keep the preset they started with.
- **The watchdog no longer kills working workers.** It failed any ticket whose row did not
  change across `loopRepeatLimit` probes — but a worker in the middle of a long edit changes
  nothing until its report. Only an *idle* streak is evidence of being stuck now, and a busy
  worker is never failed for it.
- **KPI and list cannot disagree.** `classify()` in `lib/panel.js` decides once per row
  whether it is a test artifact, whether it needs a person, and which filters show it; the
  KPI counts and the list filters both read those fields. A failing smoke ticket used to be
  counted by the attention KPI while being hidden from the attention list.

### v5 fixes — the lost-worker incident

A worker finished its artifact but never called `superagent_report`; the watchdog failed it;
the Router verified the artifact itself, got it wrong, and that wrong conclusion went into a
reopened ticket where a fresh worker trusted it. Three layers now prevent the chain:

1. **The Router cannot cross the line** (`lib/preset.js`). The preset's prompt forbids reading
   or writing a worker's workspace and forbids running anything that verifies an artifact, with
   no exception; the tool set has no `tool-fs`, `tool-bash`, `tool-pwsh`, `tool-subagent` or
   `tool-web`. A Router that can look at the artifact will look at the artifact.
2. **The lost-worker procedure is a gate** (`lib/handover.js`, `Router.reopen`).
   `superagent_status` (nudge) → `superagent_send` (remind) → `superagent_reopen` (only then).
   `reopen` refuses in code and names the missing step.
3. **The watchdog nudges before judging** (`Supervisor.inspect`). Before failing a silent
   ticket it injects "report now", grants one inspection period, and records that it asked;
   the failure reason states that a report was requested. Worker-directory file changes and
   mtime count as progress evidence (`watchdog/artifact-progress` in `route_log`) — evidence
   that holds off a failure but never finishes a ticket: the report contract stays the
   authority.
4. **A handover separates fact from guess.** A reopened ticket carries the previous worker's
   artifact paths as facts and the Router's observations as 【待核实线索】, plus the standing
   sentence 「上游结论可能错误，动手前先自行复现核实」. The panel shows the lead count in the
   collapsed row, so a skimming operator cannot mistake a guess for verified work.
5. **The worker template asks for a first report and evidence.** `superagent_report` is the
   only exit, the worker posts one `progress` immediately on accepting the task, and delivery
   tasks must name their evidence files.

Proved by `test/handover.mjs` (45), `test/watchdog.mjs` (21) and `test/preset.mjs` (35).

Proved by `test/defer.mjs` (27), `test/panel.mjs` (82), `test/client.mjs` (71),
`test/preset.mjs` (35) and `test/watchdog.mjs` (21).

## Not planned

- **Feishu Source.** Deliberately out of scope; the skill is not built.
- **Turning the Router into a model layer inside this plugin.** The Router role is played
  by the Session that calls the tools. The assessor is a separate, bounded Session that can
  only narrow. A routing model here would duplicate the Harness's own driver and make the
  Router's short answers impossible to audit.
- **Speculative execution, multi-Router sharding, a BYOM sidecar, a web page served on its
  own port.** Each is a deployment change rather than a plugin change; the single-writer
  state layer and the existing Host connection are the constraints to solve first.
