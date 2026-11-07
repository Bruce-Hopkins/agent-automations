# How to design your flow

This file is about what a flow should look like: which agents, wired how, ending
where. For flow semantics, `inputs` and joins, branches and fan-out, the
workspace, and the command contract, read [`AGENTS.md`](../AGENTS.md).

Read `leafi schema example` for a flow in the expected document shape.
That example illustrates the format; it is not a template for every task.

## Checklist before you finish or run

1. Is any context repeated between nodes? If so, reconsider the split.
2. Does the final node receive enough to answer what the user asked for?
3. Is this spending more than the task requires?
4. Is each node here because it is the best design, or because it is one step in
   the sentence the user wrote?
5. Have you told the user which model each node uses and the minimum the flow
   implies? Agents loop, so actual cost can exceed that minimum.
6. Will the final output contain what the user needs, in a form they can use?

Most bad automations come from copying the user's steps into nodes without
thinking through context, cost, and the final deliverable.

## Anti-pattern: one node per item

Do not split a task into multiple nodes when each node does the exact same thing,
like a replacement for a for-loop. One node can process many items; N nodes each
processing one item usually costs more and loses shared context.

## How many nodes?

There is no fixed answer. Start with one node that does the whole task, then
split only when one of these is true:

- `tier` — the work genuinely needs a different model.
- `permissions` — a trust boundary separates what the nodes may do.
- `isolation` — a node reads a lot and emits a little, and the bulk should not
  reach the node that reasons over it.
- `branch` — a real decision with a numeric predicate.
- `parallel` — independent sources that should not wait for each other.

Estimate each node's input and output, and prioritise accuracy over the shape of
the user's instructions. The linter is a heuristic, not a substitute for that
estimate.

Default every node to a weak model. Escalate only when you can name what the weak
model gets wrong there. Tell the user the node → model mapping and the minimum
tokens each run implies before spending them; compare actual `costUsd` when deciding
whether an escalation was worth it.

## Common shapes

### Sources side by side, one consumer

Independent sources have no edges between them: each is an entry node, and the
consumer names them in `inputs`.

```text
[ mail ]    ─┐
[ weather ] ─┼──►  [ synthesise ]  ──►  the person
[ news ]    ─┘
```

What it looks like when it is right: no edges between the sources, one consumer,
and the consumer's `inputs` naming all three. The sources run at once, and the
consumer sees each handoff directly.

The consumer still needs incoming edges from those sources. `inputs` chooses
which handoffs it receives; the edges make it wait for them. Without incoming
edges, the consumer is itself an entry node and starts concurrently.

### The isolation shape: read a lot, emit a little

Bulk reading happens on a weak model; the consumer receives a short result, never
the raw material. The expensive context is the thing to avoid, not a reward for
getting through the cheap nodes.

```text
[ fetch + reduce ]  ──►  [ synthesise ]  ──►  the person
```

A weak model is the default for every node and handles more than authors expect.
Escalate one only when you can name what the weak model gets wrong.

### The mechanical/judgement split

Fetch-and-format is mechanical; ranking, judging and writing need judgement but
not necessarily a stronger model. Split when the writer should not carry the raw
material, and keep the writer on the weak model unless you can name what it gets
wrong.

```text
[ gather, format ]  ──►  [ rank, write ]  ──►  the person
```

What it looks like when it is right: the first node names exact endpoints and
fields, and the second receives facts it can reason over, not JSON it must parse.

### A decision

The branch shape: one producer, two outcomes, each worth its own context.

```text
                 ┌─(count > 10)──►  [ deep dive ]  ──►  the person
[ check ] ───────┤
                 └─(count ≤ 10)──►  [ short note ] ──►  the person
```

What it looks like when it is right: two conditions a number or a match decides,
and no third branch that only reformats.

### The ending

The last shape: one terminal node that a person reads, marked
`audience: "person"`, with the nodes before it handing over notes rather than
rows of records. Mark only the node a person reads; its producers hand over the
specifics a reader would act on — names, amounts, dates, claims — without JSON,
HTML, or tracking noise.

```text
[ ... ]  ──►  [ the one the person reads ]     audience: "person", no outgoing edge
```

What it looks like when it is right: the run has one result, and that result is
prose the person can act on. A machine-facing final node (a graded list) is a
different thing: leave `audience` off and enforce its shape with `outputSchema`.
