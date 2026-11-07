---
name: leafi
description: Designing, validating, drawing and running leafi flows — how many nodes, which model tier per node, how to wire inputs, branches and fan-out, and how to run one through the leafi MCP tools.
---

# Using leafi

`leafi` runs a flow of LLM agents. A flow is a JSON document
(`{ name, nodes, edges }`), and the runtime is what executes it — the tools here
validate, draw and run the document; they do not author it for you.

## Authoring a flow

Call `get_flow_schema` first. Its result carries the JSON Schema **and** a
`designGuide` field: the rules for node boundaries, model tiers, `inputs`,
branches, cost and the lint warnings. Read it before writing any nodes — it is
the difference between a flow that beats a lone agent and one that loses to it.
Then call `get_example_flow` for a document in the expected shape; validate its prompts against the current input and tool semantics before reusing them.

The rules that matter most:

- A node is a context boundary, not a step. Steps sharing a tier, permissions
  and context belong in one node, however many verbs the request has.
- Split only for a different model tier, a trust boundary, isolation (read a lot,
  emit a little), a real branch with a numeric predicate, or independent sources
  that should run side by side.
- Default every node to a weak model. A strong model is an exception you have
  to justify. Looping is a major cost driver, so compare actual quality and
  `costUsd` when deciding whether escalation helped.
- Keep raw JSON out of the context — prefer `run_bash` with
  `curl -s <url> | jq '<filter>'` — and hand a downstream node a file path
  rather than the content.
- The node a person reads is marked `"audience": "person"` and gets prose, not a
  template, `linePattern` or `minLines`/`maxLines`.

## Drawing and running a flow

1. Call `validate_flow` as soon as the flow exists, and again after every
   change. It is free, and its result carries `diagram`: always include that
   drawing in your reply, even when you are only asked to design a flow — a flow
   the user never saw is a flow the user cannot correct. The drawing names each
   node's model, so it is also the node → model mapping. Use `render_flow` only
   for a Mermaid or DOT version.
2. Fix every issue `validate_flow` reports; warnings are design lint and each
   carries a repair hint.
3. Before `start_run`, state the node → model mapping and the minimum tokens
   the flow implies. The minimum is a one-pass lower bound; real use can be much
   higher when nodes loop. Call `start_run` only after the user agrees.
4. Poll `get_run` until the status is no longer `running`.
5. Paste `personOutput` in full in your reply — or, when the deliverable is a
   file, its absolute path in the run workspace. Then report token usage, the
   minimum and `costUsd`, saying whether each node's cost was `billed` or at
   `list-price`. If the run failed before the person-facing node ran,
   say so instead of presenting a partial output as the answer.
6. Use `cancel_run` when the user asks to stop.

`start_run` saves the flow under its name and returns its path as `flowFile`.
Before designing a flow, call `list_flows`: the user may already have one for
the task. Run a saved flow again with `start_run` and `flowPath`; `get_flow`
returns its document when it needs changing.

If a flow needs a permission that is turned off (`bash`, `email_read` and
`mcp` are off by default), `start_run` asks the user for it directly, and
Hermes shows that as an approval. If they decline, the error names the
permission: explain why the flow needs it, and that they can allow it with
`node ~/.hermes/plugins/leafi/dist/server.mjs settings --allow <permission>`
and a new Hermes session. Do not try to work around the policy.

## Browser nodes

The `mcp` permission gives a node the tools of one MCP server. By default that
server is chrome-devtools-mcp driving a headless Chrome, so an `mcp` node is a
browser node unless `LEAFI_MCP_COMMAND` names another server.

- Prefer `evaluate_script` returning a small array over `take_snapshot`. A
  snapshot can be tens of thousands of tokens and exhaust the node's budget.
- A site may serve different content to headless clients. If a page is blocked,
  check the user agent and test the same request in a visible browser before
  changing the flow.
- If the server-launched browser fails to start, the workaround observed on this
  engine was to launch Chrome separately and pass
  `--browserUrl=http://127.0.0.1:9222`. Treat this as a version-specific
  workaround, not a universal requirement.
- Do not set `MAX_PARALLEL_NODES=1` to serialise browser nodes. At 1, a flow
  with two entry nodes or any node with several outgoing edges (a branch
  included) stops after the first of them and still reports "completed";
  `validate_flow` warns with `parallel-limit-one`. Chain the browser nodes in a
  single line instead.
