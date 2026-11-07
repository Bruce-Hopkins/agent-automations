# Agent instructions

This repo ships a headless CLI, `leafi`, that runs a flow of LLM agents.
The binary documents its own contract: `leafi --help`, `leafi
schema` and `leafi schema example`.

Read `agents/HOW_TO_DESIGN_YOUR_FLOW.md` before designing a flow. An inefficient flow
wastes the user's tokens and money, so treat flow design as part of the task:
this file explains how a flow runs and the rules it must satisfy, while the
design guide shows the shapes a finished flow can take.


## Invocation

```bash
# Installed by install.sh / install.ps1: the command is ~/.leafi/server.mjs,
# which takes every flow command below. Its init is the installer's setup and needs a terminal.
leafi run --graph flow.json --json

# First time on a machine: writes ~/.leafi/.env and a starter ./flow.json.
# Off a terminal it asks nothing; never overwrites an existing file.
node dist/main.js init --yes

# Always works, no PATH assumptions:
node /abs/path/to/leafi/dist/main.js run --graph flow.json --json

# Inside the repo (builds first):
pnpm cli run --graph flow.json --json

# Optional real PATH entry:
pnpm add -g "link:$PWD"                # then: leafi run --graph flow.json
```

The CLI runs from compiled `dist`, so run `pnpm cli` (which builds) or `pnpm
build` after changing TypeScript.

## Authoring a flow

Get the contract before inventing field names:

```bash
node dist/main.js schema          # JSON Schema for a flow document
node dist/main.js schema example  # an example two-node flow
node dist/main.js validate --graph flow.json          # free, no model calls
node dist/main.js graph --graph flow.json             # draw as soon as it exists
node dist/main.js graph --graph flow.json --format mermaid
```

Draw the flow the moment it is written, before you validate it: the diagram is
how you and the user check the shape, and it names each node's model.

A flow is `{ name, nodes, edges }`. Domain rules, enforced by `validate`:

- at least one entry node (a node with no incoming edges); every entry runs
  from the start and receives `--input`;
- the graph is weakly connected — no island nodes;
- every node reachable from an entry, and no cycles;
- `label`, `model` and `prompt` non-empty on every node;
- when a node has more than one outgoing edge, a `branch` node (the default)
  needs a unique `branch` and a non-empty `condition` per edge, while a
  `fanout: "parallel"` node takes every edge and must not name branches.

### How a flow runs

An entry node runs when the run starts; a terminal node has no outgoing edges,
and the run ends when it completes. A node runs once, never twice, and its
whole conversation — tool calls, results, reasoning — stays inside it.

### What a link carries

An edge carries the producer's `complete_task` output and nothing else. The
consumer sees each handoff framed by the producer's node label.

By default a node receives each *direct predecessor's* handoff. A node may
instead declare `inputs: ["<node id>", ...]` — any ancestor is allowed, so the
end of a chain can read the start without a file round trip. `inputs: []` means
"ordering only": the edge runs but carries no text, which is the structural
replacement for telling a node to ignore upstream text. `"$input"` in the list
gives a non-entry node the run input explicitly. A node that declares `inputs`
receives exactly those handoffs; its other predecessors are not added back. A
declared source that did not run on the path is marked `(not run on this path)`
and skipped. Entry nodes get the run input unless they declare their own
`inputs`.

### Joins

A node with several incoming edges waits for all of them and runs once if at
least one edge was taken. A skipped node is recorded, not run.

### Branching and fan-out

With more than one outgoing edge, the node decides how execution continues:

- `fanout: "branch"` (the default) — each edge has a `branch` name and a
  `condition`; the node picks one in `complete_task` and only that edge is
  followed.
- `fanout: "parallel"` — every outgoing edge is taken, and successors may run at
  once, up to `MAX_PARALLEL_NODES` (4 by default).

A single unbranched handoff may carry a condition, which the producer sees as its
stop condition. Entry nodes have no incoming edges and may run concurrently. A
consumer that names entry nodes in `inputs` still needs incoming edges for
those nodes: `inputs` chooses which handoffs it receives, while the edges make
it wait for them and determine reachability. Without incoming edges the consumer
is itself an entry node and starts at the same time.

### The workspace

Each run gets a fresh, empty `~/.leafi/workspaces/<runId>/`, shared by
every node in that run, including nodes running at the same time. File content
enters through the run input's text, tool results, or files the run creates.
`read_file` and `write_file` are confined to that workspace. `run_bash` starts
there but is not sandboxed: a node with `bash` can reach anything the CLI user
can read or write.

A node is a handoff to another agent unless it says otherwise. Mark the one
node a person reads as the run's final result with `"audience": "person"` — it
must have no outgoing edges, and it changes how the runtime frames the node and
how the lint treats it. See *Writing for a person* below.

A node's `permissions` object gates its tools. `read`, `write`, `bash`, `web`
and `mcp` work on any machine. `email_read` additionally needs a mailbox credential in the
environment, which is per-machine state rather than part of the flow:

```bash
# Read-only mailbox access over IMAP with an app password — no OAuth client and
# no Cloud project. Google only offers an app password once 2-Step Verification
# is on. Leaving these empty simply means agents get no email tools.
LEAFI_EMAIL_ADDRESS=you@gmail.com
LEAFI_EMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
```

`run` checks credentials before spending tokens. A flow whose nodes need
`email_read` fails pre-flight with exit `4` when no mailbox is configured or the
login is rejected; the pre-flight performs one real IMAP login. Mail is
read-only: there is no send tool.

`mcp` gives a node tools from an MCP server, started per node over stdio. By
default the server is chrome-devtools-mcp driving a headless Chrome, so an `mcp`
node is a browser node unless you point it elsewhere. Configure its launcher,
timeout and allowed tools with `LEAFI_MCP_COMMAND`,
`LEAFI_MCP_TIMEOUT_MS` and `LEAFI_MCP_TOOLS`; to use another
server, set the command and its tool names together. A flow requesting `mcp`
fails pre-flight if the launcher cannot start or offers none of those tools.

`position` and `viewport` are optional and default to zero, so a headless author
never needs canvas coordinates. `id` is optional and generated when absent, but
supply one per node and reference it from `edges.source`/`edges.target` when you
want deterministic wiring.

Validate before spending tokens — it is free and makes no model calls:

```bash
node dist/main.js validate --graph flow.json
node dist/main.js schema example | node dist/main.js validate --graph -
```

`validate` prints `{"ok":bool,"issues":[...],"warnings":[...]}` and exits `2` on
issues. `issues` mean the document is malformed; `warnings` are design lint —
same `code`/`message`/`nodeId` shape plus a `hint` with the repair. Read them:
they are the difference between a flow that beats a lone agent and one that
loses to it. Pass `--strict` to make warnings exit `2`.

The shapes a finished flow can take are in `agents/HOW_TO_DESIGN_YOUR_FLOW.md`; the
rules they serve are below. When a warning is a false positive, opt the node out
with `"lintIgnore": ["<code>"]`.

## Lint rules, and the failure each one prevents

| Code | What it catches |
| --- | --- |
| `json-via-web-fetch` | `web_fetch` used for a JSON API: use `run_bash` with `curl -s <url> \| jq` |
| `no-exact-endpoint` | a node that can fetch but names no URL |
| `qualitative-branch` | branching on a vibe instead of a numeric predicate |
| `downstream-reads-input` | a non-entry node expecting the run input |
| `rigid-deliverable` | a template or a line check on a node a person reads (`audience: "person"`) |
| `concurrent-write` | two nodes that may run at once writing the same workspace path |
| `parallel-limit-one` | `MAX_PARALLEL_NODES` at 1 while two nodes can be ready at once, which loses outputs |

## A node is a context boundary, not a step

Start from one node that does the whole task, then split only when one of these
is true:

| Reason | Example |
| --- | --- |
| `tier` — the work genuinely needs a model the rest do not | a vision model for the one node that reads screenshots |
| `permissions` — a trust boundary | the node reading untrusted input must not hold `bash` |
| `isolation` — a node reads a lot and emits a little, and the bulk must not reach the node that reasons over it | a large document reduced to a short summary before the writer sees it |
| `branch` — a real decision with a numeric predicate | |
| `parallel` — independent sources that should not wait for each other | |

Steps that share a tier, permissions and context belong in one node, however
many verbs the request has. "Get news, get weather" is one node with two
`run_bash` calls — or one `run_bash` call.

Worked example: "read the repo, run the tests, write a summary". Reading and
running are mechanical and share a tier; the summary needs judgement and should
not carry the raw material. That is two nodes, not three — because nothing about
the first three verbs requires a separate context. Both stay on the weak model
by default: the split is for the context, not to escalate.

## Writing for a person

The final node a person reads is not a handoff. Mark it `audience: "person"`,
and write it as prose for that reader rather than a record for an agent:

- **Give it a reader.** Two or three sentences: who they are, what they follow,
  what counts as urgent. Put that in the prompt. An agent cannot infer a reader
  from its inputs.
- **State the purpose and the register.** "The way a sharp colleague would brief
  them over coffee", "warm but not chatty", "something they can read in two
  minutes". Register is a requirement like any other; if no clause asks for it,
  the output has none.
- **Use no line checks and no verbatim template.** No `linePattern`, no
  `minLines`/`maxLines`, no "content in exactly this shape". A template writes
  the framing for the model; a line cap truncates every thought to one line.
  `rigid-deliverable` fires on both.
- **Its producers hand over notes, not rows.** A `sender - subject - gist` or
  `title - points - url` record is formatting built for a machine; the writer
  cannot say more than it receives. Ask for a short paragraph per item with the
  specifics a reader would act on — names, amounts, dates, claims. Strip noise
  (JSON, HTML, tracking URLs), not substance.
- **Cost.** Nothing re-sends that node's output, so its length is paid once, as
  output tokens. The producers' notes are what cost context, and they are read
  on the default weak model — so `isolation` is the split reason.

A flow may still have a machine-facing final node (a benchmark list graded line
by line). That is what `outputSchema` is for; leave `audience` off it.

## Cheap and precise flows

Every node re-sends its system prompt, its task and its upstream handoffs to a
model on every loop iteration — including every tool result so far. A flow costs
roughly (nodes) × (prompt size + tool results) × (loop iterations). Precision
is what holds the iteration count near one, and small tool results are what
keep the per-iteration price down. Model tier matters less than looping: a flow
of weak nodes that each settle in one or two iterations often costs less than
one strong node that thrashes, but looping can make any model expensive. Judge
flows on actual `costUsd` and output quality, not raw token count or model tier
alone.

Spending:

- Default every node to a weak model (haiku/mini class). Escalate one only when
  you can name what the weak model gets wrong there, and agree the node → model
  mapping with the user before running. A weak model is cheaper per token, but
  repeated iterations can erase that advantage; compare results when it matters.
- Keep raw JSON out of the context. A fetch node's tool results are re-sent on
  every one of its iterations, so three 30 KB API responses are paid for
  several times over. When a node has `bash`, prefer
  `run_bash` with `curl -s <url> | jq '<filter>'` over `web_fetch`: project
  the exact fields (`jq '[.hits[] | {title, url, points}]'`) so only the
  kilobyte you need ever enters the conversation. Use `web_fetch` for pages
  with no API and for one-shot reads. This targets formatting noise, not the
  facts: a producer for a person-facing node keeps the specific numbers, names
  and claims and drops the braces.
- Prefer fewer nodes. If one agent can fetch and format, do not split it across
  two: you pay two prompts and two handoffs for the same result.
- Batch tool calls. `runAgentLoop` executes *every* tool call in one model
  response before the next iteration, so ten `email_get_message` calls issued in
  one turn cost two iterations, not eleven. Ask for it in the prompt: "call
  `email_get_message` for every uid in a single turn". This is the largest
  saving on a per-item read and needs no code.
- Push bulk through the workspace, not through handoffs. A node receives only
  the handoffs its `inputs` name (direct predecessors by default), so passing a
  file path costs a line where passing the content costs a copy in every
  downstream prompt.
- Do not re-fetch what an earlier node already wrote, and do not give two nodes
  the same source to fetch. Pass the path, or fetch once and hand it on.
- Tool results returned to the model are capped at `BASH_OUTPUT_LIMIT_BYTES`
  (32 KiB by default), including text returned by `web_fetch`; the download
  itself is capped separately at `WEB_FETCH_LIMIT_BYTES`. A cut result starts
  with a note saying so, and a `run_bash` result shows its start and its end,
  because errors come last. A longer result is saved whole (up to
  `TOOL_OUTPUT_SAVE_LIMIT_BYTES`, 1 MiB) to `.tool-output/` in the workspace,
  and `read_file` with `offset` reads on from it, piece by piece — so nothing is
  lost, but every piece is another capped result re-sent on later iterations.
  All results of one model response together return at most
  `TOOL_OUTPUT_STEP_LIMIT_BYTES` (128 KiB). Size batches to fit: a prompt that
  asks for 30 rows at once when 30 rows are 26 KB gets them cut. Shrink a response server-side with query
  parameters and filters so the payload arrives already small, and client-side
  with `jq` so what arrives is smaller still.
- `MAX_NODE_ITERATIONS` (25 by default) is a budget, not a target. A node that
  explores burns tokens and can still be cut off. Every step tells the node how
  many model calls it has left (counting the run-wide `MAX_RUN_STEPS` when
  that is closer), and from three left it is told to wrap up. The last call
  offers only `complete_task`, so a node that runs out hands over what it has:
  the run lists it in `stoppedEarlyNodes`, and its successors are told the
  handoff is partial. A node whose work genuinely needs more calls than the
  rest can set `"maxIterations"`; `MAX_RUN_STEPS` still limits the run.
- Never spend model calls waiting. A shell command runs for up to
  `BASH_TIMEOUT_MS` (2 minutes) and may ask for up to 10 with
  `timeoutSeconds`. Anything longer — a crawl, a build — is a background job:
  `run_bash` with `background: true` returns a job id at once, its output goes
  to `.jobs/<id>.log`, and `wait_job` waits for it in one call. A job still
  running when its node finishes is handed to the next node, which can check on
  it, wait for it or stop it; `"waitForJobs": true` makes that node wait before
  it starts, at no model cost. Jobs still running when the run ends are
  stopped. Prompt for this explicitly ("start both scrapers with
  `background: true`, then `wait_job`"), never for `sleep` loops or `nohup … &`.

Precision:

- Name the exact endpoint, query and fields. "Get the news" invites a search
  loop; `https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story`
  does not.
- Prefer a JSON API over scraping HTML, and say which fields to read.
- State the exact output path and the exact shape you want. That gives
  downstream nodes a deterministic contract and leaves them no judgement. This
  applies to output a machine consumes; the final node a person reads is not a
  handoff (see *Writing for a person*).
- Say what to do when data is missing ("note it; never invent") — that is the
  difference between an honest digest and a fabricated one.
- Grant the minimum permissions. A node holding only the tools it needs makes
  fewer wrong choices, and every extra tool is another schema in its prompt.
- Only entry nodes see `--input`; downstream nodes see the handoffs their
  `inputs` declare. Put anything that must be parameterised at an entry node, or
  into the prompt; declare `"$input"` in `inputs` to pass the run input on
  purpose.
- Add a branch only for a real decision, decided by a numeric predicate. Each
  extra edge costs a `branch` + `condition` pair and a choice the model can get
  wrong.
- Independent entry nodes may run at once (`MAX_PARALLEL_NODES`, 4 by default).
  They share one workspace, so give each its own output path; two concurrent
  writers of one path earn `concurrent-write`.
- `validate` and `graph` are free. Run both before every `run`.

## Running a flow

```bash
node dist/main.js graph --graph flow.json              # draw; show it before running
node dist/main.js run --graph flow.json --input "summarise ./src" --json
node dist/main.js run --graph - --input-file task.txt --json
node dist/main.js run --graph flow.json --events pretty --diagram
node dist/main.js run --graph flow.json --no-save
```

`--data-dir <path>` and `DATA_DIR` / `LEAFI_HOME` move run artifacts out
of the default `~/.leafi`. Settings come from `~/.leafi/.env`
(the data directory's `.env`) — never a `.env` in the current directory — and
`--env-file <path>` loads a specific file instead.
`--no-save` keeps the workspace but writes neither `meta.json` nor
`events.jsonl`.

stdout carries data only (NDJSON events, then a `{"type":"result","run":{...}}`
line); stderr carries progress and warnings. The result's `usage`
field reports tokens and model iterations per node, when the provider reports
them, including cache reads and writes and reasoning tokens, and `costUsd` is
what the run actually cost. Each call is priced as it returns, and each node's
`costSource` says how:

- `billed`: what the provider reported it charged. OpenRouter reports this on
  every call, including time-of-day prices, so it matches the bill.
- `list-price`: the call's tokens priced from the table in
  `src/domain/model-prices.ts`, with the cache, long-prompt and dated rates that
  apply. OpenAI, Anthropic and Google report tokens but never dollars, so this
  is the closest a run can get for them. `pricesAsOf` gives the table's date.

`minimum` next to it is a one-pass lower bound, in tokens, that the flow *asks
for* before it ran. The gap can be large because every iteration re-sends the
context so far, and it varies with looping and model behavior rather than
following a fixed multiplier. Its `note` says so in the payload, so no consumer
can read it as a forecast. A call that cannot be priced (a model the table does
not cover with no billed cost, or a tier it does not price) leaves `costUsd`
unset and is named in `unpricedModels` rather than quietly understating the
total.

`outputs` is keyed per node. `personOutput` is the deliverable: the output of
the node marked `audience: "person"`, and it is absent when that node did not
run. Reproduce `personOutput` in full in your reply — do not summarise it and do
not say only that the run completed. If the deliverable is a file, print its
absolute path inside `~/.leafi/workspaces/<runId>/`. A failed or
cancelled run may have no `personOutput` at all; say so rather than presenting a
partial node output as the answer.

Branch on the exit code:

| Code | Meaning |
| --- | --- |
| `0` | completed — read `personOutput` and `outputs` |
| `1` | the flow ran but failed or was cancelled — check `error`/`failedNodeId` |
| `2` | malformed JSON or validation issues — fix the flow |
| `3` | usage error — fix the command |
| `4` | pre-flight failure — a missing provider key, a rejected mailbox login, or an MCP server launcher/tool problem; fix the environment |

Pass `--events none` to suppress the event stream, `--events pretty` for human
progress on stderr, or `--events ndjson` (the default off a TTY) for the raw
stream. The event envelope is the same shape persisted in `events.jsonl`, so a consumer
can be written once for the live stream and the stored log.

## MCP server

The same engine is exposed over stdio by `leafi-mcp` from a clone,
and by `~/.leafi/server.mjs --transport stdio` when installed. All
logs go to stderr because stdout carries JSON-RPC.

| Tool | What it returns |
| --- | --- |
| `get_flow_schema` | The flow JSON Schema plus `designGuide`; read the guide before authoring. |
| `get_example_flow` | The example flow (`schema example` in the CLI). |
| `validate_flow` | `ok`, `issues`, `warnings`, each node's `minimum` and the ASCII `diagram`. |
| `render_flow` | A drawing; `format` is `ascii`, `mermaid` or `dot`. |
| `list_providers` | The providers whose keys are set, with their models. |
| `start_run` | The run, with its `id` and `flowFile`; the run continues in the background. |
| `list_flows` | Every saved flow, newest first: `name`, `file`, `nodes`, `savedAt`. |
| `get_flow` | One saved flow's document and file, by `name`. |
| `get_run` | `status`, `outputs`, `personOutput`, `usage`, `costUsd`, `jobs`, `error`. |
| `get_run_events` | Events with `seq >= afterSeq` (`limit` 100 by default, at most 500); `reasoning: true` adds reasoning text. |
| `cancel_run` | Whether an in-flight run was cancelled. |
| `list_runs` | Recent runs, newest first (`limit` 20 by default, at most 100). |

The flow tools take exactly one of `flow` (the document) or `flowPath`, and
`flowPath` works only while `LEAFI_ALLOW_FLOW_PATHS` is true. The
loop is the one under *Delivery*: `validate_flow` and show its `diagram`, state
the node → model mapping and the minimum, call `start_run` only once the user
agrees, poll `get_run` until `status` is no longer `running`, then reproduce
`personOutput` in full with `costUsd`. To follow progress, page
`get_run_events` with `afterSeq` set to the last `seq` you saw plus one.

`start_run` saves every flow it runs to `<data dir>/flows/<name>.json`,
replacing a saved flow with the same name, so a flow outlives the conversation
that wrote it. Call `list_flows` before designing a flow the user may already
have, and run a saved one with `flowPath`.

Dangerous permissions are denied unless the server environment grants the
matching `LEAFI_ALLOW_*` setting; `init` offers `web` and `write`
on and `bash`, `email` and `mcp` off. When a flow requests a denied one,
`start_run` asks the person through the client (MCP elicitation), naming the
nodes; the agent cannot answer. Accepting allows it for that run; "always"
also saves it to the settings file the server read. A refusal, or a client that
cannot ask, fails the flow before any model call. `leafi settings --allow <ids>` /
`--deny <ids>` writes those settings without editing the file, to every file in
use (Hermes's `.env` when the Hermes plugin is installed, and
`~/.leafi/.env`); with neither flag off a terminal it prints them.
Ask the user before granting one; a change made this way needs the server restarted.

To change the server: `src/mcp` is an adapter with no graph logic. It calls the
same `src/app` services as the CLI, and each tool is one file in
`src/mcp/tools`, registered in `src/mcp/registry.ts`.

## What a run can see

There is no `--workspace`, so a run cannot mount an existing directory.
`--input-file` loads a file's text into the input; it does not place the file in
the workspace. `read_file` and `write_file` stay inside the run workspace.
`run_bash` begins there but can reach the host outside it, so keep `bash` and
`write` disabled for untrusted flows. A node receives only the tools its
permissions enable. Child processes get an allowlist environment (`PATH`,
locale, and names in `AGENT_ENV_PASSTHROUGH`), so provider keys and the mailbox
password are not forwarded.

## Verifying a change to the CLI

```bash
pnpm typecheck
pnpm build
```

Then exercise the real paths: `schema example | validate --graph -` must exit
`0`, `pnpm test` must pass, and a `run` against a configured provider must print
a `result` line and exit `0`.

## Enforcing a handoff shape

A node can declare the shape of its `complete_task` output. The runtime checks
it the moment the tool is called and, on a mismatch, rejects the output back to
that node with the violations instead of passing malformed data downstream. The
agent gets at most three attempts; after that the node fails the run, naming the
violation. Optional and per node:

```json
"outputSchema": {
  "minLines": 10, "maxLines": 10,
  "linePattern": "^\\d+\\. .+ — https?://",
  "linePatternHint": "number, title, then a link",
  "mustContain": ["## Weather"],
  "mustNotContain": ["I cannot", "I am unable"]
}
```

Semantics: lines are counted after trimming, so blank separators do not count;
`mustContain`/`mustNotContain` are case-insensitive. `validate` rejects a schema
that no output could satisfy (an impossible regex, `minLines > maxLines`, a
string both required and forbidden). Use it wherever a downstream node depends
on a shape — a count, a section, a per-line format — because prose in the prompt
is a request and this is a check. Rejections are logged as `output_rejected`
events. This is for a **handoff** — output a machine consumes. A person-facing
node needs the opposite treatment: see *Writing for a person* above.

## Delivery

Never run an automation without the user's permission. Draw the flow as soon as
it exists and include the drawing in the reply that hands it over: a flow the
user never saw is a flow the user cannot correct. Drawing is free and names each
node's model, so it also carries the node → model mapping. Before spending
tokens, state that mapping and the minimum tokens the flow implies, and get the
user's agreement. Run only with their permission.
