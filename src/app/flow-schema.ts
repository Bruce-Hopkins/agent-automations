const PROVIDERS = ['openai', 'anthropic', 'google', 'openrouter'];

/**
 * Static contract for a flow document. Domain rules that JSON Schema cannot
 * express — at least one entry node, acyclicity, reachability, branch uniqueness — are
 * reported by `leafi validate`.
 */
export const FLOW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://leafi.local/schema/flow.json',
  title: 'leafi flow',
  description:
    'A flow document. Runtime-owned fields are not accepted; id, createdAt and updatedAt are added when the flow is loaded. Domain rules: at least one entry node (no incoming edges), all of which run in parallel and receive --input; the graph must be connected; every node reachable from an entry; no cycles; label, model and prompt non-empty; with more than one outgoing edge, a "branch" node needs a unique branch and a non-empty condition per edge, a "parallel" node takes them all. "leafi validate" additionally reports design warnings (severity "warning") and a per-node minimum (tokens the flow implies, a lower bound) for flows that would waste tokens or decide non-deterministically.',
  type: 'object',
  required: ['nodes', 'edges'],
  properties: {
    name: {
      type: 'string',
      description: 'Display name. Defaults to "Untitled automation".',
    },
    nodes: {
      type: 'array',
      minItems: 1,
      description: 'Agents. Every node with no incoming edges is an entry node; there may be several.',
      items: {
        type: 'object',
        required: ['provider'],
        properties: {
          id: { type: 'string', description: 'Optional; generated when absent. Referenced by edges.source/target.' },
          label: { type: 'string', minLength: 1, description: 'Required by validation.' },
          provider: { enum: PROVIDERS },
          model: { type: 'string', minLength: 1, description: 'Required by validation.' },
          prompt: { type: 'string', minLength: 1, description: 'Required by validation.' },
          permissions: {
            type: 'object',
            description:
              'Tools the agent may use. All default to false. email_read needs a mailbox credential (LEAFI_EMAIL_ADDRESS and LEAFI_EMAIL_APP_PASSWORD). mcp launches the configured MCP server for this node (by default chrome-devtools-mcp, a headless Chrome), configured with LEAFI_MCP_COMMAND and LEAFI_MCP_TOOLS.',
            properties: {
              read: { type: 'boolean', default: false },
              write: { type: 'boolean', default: false },
              bash: { type: 'boolean', default: false },
              web: { type: 'boolean', default: false },
              email_read: {
                type: 'boolean',
                default: false,
                description: 'email_search and email_get_message — read the mailbox. Read-only: there is no send tool.',
              },
              mcp: {
                type: 'boolean',
                default: false,
                description:
                  'The tools of the MCP server set by LEAFI_MCP_COMMAND, limited to LEAFI_MCP_TOOLS. By default that is a real Chrome through the chrome-devtools-mcp server: new_page, navigate_page, take_snapshot, evaluate_script and the rest. Use the browser for pages that block plain HTTP fetches.',
              },
            },
          },
          outputSchema: {
            type: 'object',
            description:
              'Enforced shape of this node\'s complete_task output. The runtime checks it and rejects a non-complying output back to the agent, so a handoff contract is verified rather than merely requested. Optional.',
            properties: {
              minLines: { type: 'integer', minimum: 0, description: 'Lower bound on non-empty lines (trimmed).' },
              maxLines: { type: 'integer', minimum: 0, description: 'Upper bound on non-empty lines.' },
              linePattern: { type: 'string', description: 'Regular expression every non-empty line must match.' },
              linePatternHint: { type: 'string', description: 'Plain-language gloss of linePattern, shown to the agent.' },
              mustContain: { type: 'array', items: { type: 'string' }, description: 'Substrings the output must include (case-insensitive).' },
              mustNotContain: {
                type: 'array',
                items: { type: 'string' },
                description: 'Substrings the output must not include, e.g. "I cannot".',
              },
            },
          },
          lintIgnore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Lint rule codes this node opts out of, e.g. ["json-via-web-fetch"] when the endpoint really is HTML. See "leafi validate".',
          },
          inputs: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Node ids whose complete_task output this node receives — any ancestor, not just a direct predecessor. Absent keeps the direct-predecessor behaviour; [] means ordering only, no handoff text; "$input" adds the run input for a non-entry node.',
          },
          needs: {
            type: 'string',
            description:
              'One sentence: what this node does with its inputs. Shown to its producers in their system prompt so they know the contract.',
          },
          fanout: {
            enum: ['branch', 'parallel'],
            description:
              'How several outgoing edges are taken. "branch" (default) means the agent chooses one by branch name; "parallel" takes every edge, and its successors may run concurrently.',
          },
          audience: {
            enum: ['person'],
            description:
              '"person" marks this node as the run\'s final result: a person reads its output. Valid only on a node with no outgoing edges. The runtime then frames the node as writing for a reader rather than handing off to an agent.',
          },
          maxIterations: {
            type: 'integer',
            minimum: 1,
            description:
              'Model calls this node may make, in place of the MAX_NODE_ITERATIONS setting (25 by default). Use it for the one node whose work needs more; the run-wide MAX_RUN_STEPS still limits the total.',
          },
          waitForJobs: {
            type: 'boolean',
            description:
              'Hold this node until every background job handed to it (run_bash with background: true, still running when its producer finished) has ended. Waiting costs no model calls, and the node starts with each job\'s final status and the end of its log. Off by default.',
          },
          position: {
            type: 'object',
            description: 'Canvas coordinates. Optional; defaults to {x:0,y:0} for headless flows.',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
            },
          },
        },
      },
    },
    edges: {
      type: 'array',
      description: 'Handoffs. Control moves here only after a node calls complete_task.',
      items: {
        type: 'object',
        required: ['source', 'target'],
        properties: {
          id: { type: 'string', description: 'Optional; generated when absent.' },
          source: { type: 'string', description: 'Source node id.' },
          target: { type: 'string', description: 'Target node id.' },
          branch: {
            type: 'string',
            description: 'Required and unique per source when that node has more than one outgoing edge.',
          },
          condition: {
            type: 'string',
            description: 'When this handoff applies. Required alongside branch; optional for a lone handoff.',
          },
        },
      },
    },
    viewport: {
      type: 'object',
      description: 'Canvas view state. Unused by the CLI.',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        zoom: { type: 'number' },
      },
    },
  },
} as const;

/** Guaranteed to pass `leafi validate`; `schema example | validate --graph -` exits 0. */
export const EXAMPLE_FLOW = {
  name: 'Review pipeline',
  nodes: [
    {
      id: 'plan',
      label: 'Planner',
      provider: 'openai',
      model: 'gpt-4o-mini',
      prompt:
        'Break the task in the run input into concrete, numbered steps. For each step, name the file it creates or changes and what that file must contain. If the task leaves something out, say what is missing; never invent requirements.',
    },
    {
      id: 'fix',
      label: 'Fixer',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      prompt:
        "Carry out the Planner's steps in the run workspace, which starts empty: create and edit files with write_file and run_bash, and check what you wrote with read_file. Then list each file you created or changed on its own line. If a step cannot be carried out, say which and why; never claim a change you did not make.",
      permissions: { read: true, write: true, bash: true },
      outputSchema: {
        minLines: 1,
        mustNotContain: ['I cannot', 'I am unable'],
      },
    },
  ],
  edges: [{ id: 'e1', source: 'plan', target: 'fix', condition: 'steps produced' }],
} as const;
