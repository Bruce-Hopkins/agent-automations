export type ProviderId = 'openai' | 'anthropic' | 'google' | 'openrouter';

export const PROVIDER_IDS: readonly ProviderId[] = ['openai', 'anthropic', 'google', 'openrouter'];

/**
 * What a single node's agent may do. Every toggle is off until the user grants
 * it. `read` and `write` are jailed to the run directory; `bash` is not a
 * sandbox. `email_read` needs a mailbox credential in the environment (see
 * `email/email-read.ts`).
 */
export interface NodePermissions {
  read: boolean;
  write: boolean;
  bash: boolean;
  web: boolean;
  email_read: boolean;
  /**
   * Tools from the configured MCP server (by default chrome-devtools-mcp, a
   * headless Chrome), launched per node that holds this.
   */
  mcp: boolean;
}

/**
 * A contract the node's `complete_task` output must satisfy. The runtime checks
 * it and rejects a non-complying output back to the agent, so a handoff shape
 * is enforced rather than merely requested in the prompt.
 */
export interface OutputSchema {
  /** Non-empty lines, counted after trimming. */
  minLines?: number;
  maxLines?: number;
  /** Every non-empty line must match this regular expression. */
  linePattern?: string;
  /** Plain-language gloss of `linePattern`, shown to the agent. */
  linePatternHint?: string;
  /** Substrings (case-insensitive) the output must include. */
  mustContain?: string[];
  /** Substrings (case-insensitive) the output must not include. */
  mustNotContain?: string[];
}

/** How a node with several outgoing edges routes: choose one, or take all. */
export type Fanout = 'branch' | 'parallel';

/** One agent configured by the user. Position is optional and unused headlessly. */
export interface AgentNode {
  id: string;
  label: string;
  provider: ProviderId;
  model: string;
  prompt: string;
  permissions: NodePermissions;
  position: { x: number; y: number };
  /** Optional enforced shape of this node's handoff. */
  outputSchema?: OutputSchema;
  /** Optional lint rules this node opts out of, by rule code. */
  lintIgnore?: string[];
  /**
   * Node ids whose handoff this node receives, any ancestor allowed. Absent
   * means direct predecessors; `[]` means ordering only; `"$input"` adds the
   * run input for a non-entry node.
   */
  inputs?: string[];
  /** One sentence: what this node does with its inputs, shown to its producers. */
  needs?: string;
  /** How several outgoing edges are taken. Default `"branch"`: choose one. */
  fanout?: Fanout;
  /**
   * Set to `"person"` when a person reads this node's output as the run's
   * final result. Valid only on a terminal node (no outgoing edges); the
   * runtime then frames the node as writing for a reader rather than handing
   * off to an agent.
   */
  audience?: 'person';
  /**
   * Model calls this node may make, in place of `MAX_NODE_ITERATIONS`, for a
   * node whose work needs more (or fewer) than the rest. The run-wide
   * `MAX_RUN_STEPS` still limits the total.
   */
  maxIterations?: number;
  /**
   * Hold this node until every background job handed to it has ended, at no
   * model cost, so it starts with their final status. Off by default.
   */
  waitForJobs?: boolean;
}

/**
 * A handoff from one agent to the next. `branch` names the choice when a source
 * fans out; `condition` says when that handoff (or the single handoff) applies.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  branch?: string;
  condition?: string;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Graph {
  id: string;
  name: string;
  nodes: AgentNode[];
  edges: GraphEdge[];
  viewport?: GraphViewport;
  createdAt: string;
  updatedAt: string;
}

/** `Graph` without server-owned fields — what clients send when saving. */
export type GraphPayload = Omit<Graph, 'id' | 'createdAt' | 'updatedAt'>;

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Which frontend started the run. */
export type RunSource = 'cli' | 'mcp';

/** One execution of a graph. */
export interface RunUsage {
  input: number;
  output: number;
  total: number;
}

/**
 * Where a node's dollars come from: `billed` is what the provider reported it
 * charged (OpenRouter); `list-price` is the tokens priced from the table in
 * `model-prices.ts`, as of the run's `pricesAsOf`.
 */
export type CostSource = 'billed' | 'list-price';

/** What one node spent, priced at its own model. */
export interface NodeUsage extends RunUsage {
  iterations: number;
  /** Absent on runs recorded before the model was kept with the usage. */
  model?: string;
  /** Input tokens read from the provider's prompt cache; included in `input`. */
  cacheRead?: number;
  /** Input tokens written to the provider's prompt cache; included in `input`. */
  cacheWrite?: number;
  /** Reasoning or thinking tokens; included in `output`. */
  reasoning?: number;
  /** Dollars for these calls, absent when any call could not be priced. */
  usd?: number;
  costSource?: CostSource;
  /**
   * What the upstream provider charged, present only when OpenRouter reports a
   * figure different from `usd` (as with your own provider key). Not added in.
   */
  upstreamUsd?: number;
  /** Why `usd` is absent: the model, or the model and the tier it ran on. */
  unpriced?: string;
}

export interface Run {
  id: string;
  graphId: string;
  graphName: string;
  input: string;
  status: RunStatus;
  source?: RunSource;
  outputs: Record<string, string>;
  /**
   * The run's deliverable: the output of the node marked `audience: "person"`,
   * present only when that node ran. `outputs` still holds every node's output.
   */
  personOutput?: { nodeId: string; output: string };
  startedAt: string;
  finishedAt?: string;
  error?: string;
  failedNodeId?: string;
  /** Tokens consumed per node, when the provider reports them. */
  usage?: Record<string, NodeUsage>;
  /** Dollars for the whole run: present only when every node's model was priced. */
  costUsd?: number;
  /** Models (or a model and the tier it ran on) that could not be priced, when they blocked `costUsd`. */
  unpricedModels?: string[];
  /** The price table's date, present when any node was priced at list price. */
  pricesAsOf?: string;
  /**
   * Nodes that used their last model call and handed over a partial result.
   * Their successors were told the handoff is partial.
   */
  stoppedEarlyNodes?: string[];
  /** Every background job the run started, as each one ended (or stood when the run ended). */
  jobs?: RunJob[];
}

export type JobStatus = 'running' | 'exited' | 'stopped' | 'timed out';

/** One background job: started with `run_bash` `background: true`, or taken on from a command's `&`. */
export interface RunJob {
  id: string;
  command: string;
  /** The node that started (or took on) the job. */
  nodeId: string;
  startedAt: string;
  /** When the job is killed if it is still running. */
  deadline: string;
  status: JobStatus;
  endedAt?: string;
  /** The exit code of the job's shell, when it exited on its own. */
  exitCode?: number | null;
  /** The job's output, relative to the workspace; absent for a process taken on from `&`. */
  log?: string;
  /** A process a foreground command left running, taken on rather than started as a job. */
  adopted?: boolean;
  /** Why a job that did not exit on its own ended. */
  reason?: string;
}

export type RunEventType =
  | 'node_started'
  | 'agent_message'
  | 'model_call'
  | 'model_timeout'
  | 'job_started'
  | 'job_ended'
  | 'jobs_waited'
  | 'tool_call'
  | 'output_rejected'
  | 'node_completed'
  | 'node_skipped'
  | 'node_failed'
  | 'edge_taken'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled';

/** Append-only log entry, replayed by `runs show` and the MCP adapter. */
export interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  type: RunEventType;
  nodeId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  models: string[];
}

/** A mailbox login, from the environment. Both halves are required. */
export interface EmailCredentials {
  address: string;
  appPassword: string;
  imapHost: string;
  imapPort: number;
}

/**
 * The mailbox connection as the CLI and MCP adapter see it. There is no
 * connection to establish and no token to refresh: an app password is either in
 * the environment or it is not. `configured` is therefore the whole story, and
 * whether the password actually works is answered by a live login at run time.
 */
export interface EmailStatus {
  /** `LEAFI_EMAIL_ADDRESS` and `LEAFI_EMAIL_APP_PASSWORD` are both present. */
  configured: boolean;
  /** The mailbox the agent will read, when configured. */
  address?: string;
}

export type ValidationCode =
  | 'empty-graph'
  | 'duplicate-node'
  | 'duplicate-edge'
  | 'missing-field'
  | 'invalid-provider'
  | 'unknown-endpoint'
  | 'self-loop'
  | 'cycle'
  | 'entry-count'
  | 'disconnected'
  | 'unreachable'
  | 'missing-branch'
  | 'missing-condition'
  | 'duplicate-branch'
  | 'invalid-output-schema'
  | 'unknown-input'
  | 'invalid-fanout'
  | 'branch-on-parallel'
  | 'invalid-audience';

/** Fields a caller may synthesize for the minimum; the calculation stays pure. */
export interface MinimumLimits {
  maxNodeIterations: number;
  toolOutputLimitBytes: number;
}

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}
