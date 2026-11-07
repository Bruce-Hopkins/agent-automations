import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeConfig } from '../config/runtime-config';
import { PRICES_AS_OF } from '../domain/model-prices';
import { branchNames, handoffs } from '../domain/graph-utils';
import { usesEmail } from '../domain/permissions';
import type { AgentNode, Graph, NodeUsage, Run } from '../domain/types';
import { EmailService } from '../email/email-service';
import { runAgentLoop } from '../graph/agent-loop';
import { compileGraph, type GraphRuntime, type NodeResult } from '../graph/graph-compiler';
import { findNodeFailure, NodeFailureError, describeError } from '../graph/node-failure';
import { buildNodeInput, buildSystemPrompt } from '../graph/prompt';
import { takenIncoming } from '../graph/routing';
import type { RunState } from '../graph/run-state';
import { ModelFactory } from '../providers/model-factory';
import { UsageMeter } from '../providers/usage-meter';
import { createEmailToolkit, type EmailToolkit } from '../tools/email/email-toolkit';
import { createMcpToolkit, type McpToolkit } from '../tools/mcp/mcp-toolkit';
import { duration, JobRegistry, NodeJobs, type JobRecord } from '../tools/jobs';
import { createNodeToolkit, createToolOutput } from '../tools/node-toolkit';
import type { ToolOutput } from '../tools/tool-output';
import { Workspace } from '../tools/workspace';
import { RunEventSink, type RunEventListener } from './run-events';
import { RunStore } from './run-store';

const MESSAGE_LOG_LIMIT = 8000;
/** Below this much run time left, every step note shows the run's clock. */
const CLOCK_SHOWN_BELOW_MS = 10 * 60 * 1000;
/** How much of each handed-on job's log a node starts with. */
const HANDED_JOB_TAIL_BYTES = 1024;
/** How long to let aborted siblings unwind before the run's final event. */
const DRAIN_TIMEOUT_MS = 10_000;

interface RunBudget {
  steps: number;
  timedOut: boolean;
}

export interface RunLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface ExecuteRunOptions {
  /** Persist `meta.json` and `events.jsonl`. The workspace is always created. */
  save: boolean;
  onEvent?: RunEventListener;
  /** Aborts the run, e.g. from SIGINT or an MCP cancel request. */
  signal?: AbortSignal;
  /**
   * Files copied into the fresh workspace, by name, before any node runs. For
   * replaying a node on a saved run's files (`pnpm bench`); deliberately not a
   * CLI flag, so a run still cannot mount a directory.
   */
  seedFiles?: string[];
}

const SILENT_LOGGER: RunLogger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Runs one graph to completion. Never rejects: the returned `Run` always carries
 * the final status, error and outputs.
 */
export class RunExecutor {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: RunStore,
    private readonly models: ModelFactory,
    private readonly email: EmailService,
    private readonly logger: RunLogger = SILENT_LOGGER,
  ) {}

  cancel(runId: string): boolean {
    const controller = this.active.get(runId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  async execute(graph: Graph, run: Run, input: string, options: ExecuteRunOptions): Promise<void> {
    const controller = new AbortController();
    const budget: RunBudget = { steps: 0, timedOut: false };
    let timer: NodeJS.Timeout | undefined;
    this.active.set(run.id, controller);

    const onExternalAbort = (): void => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    let sink: RunEventSink;
    try {
      sink = await RunEventSink.open({
        runId: run.id,
        file: options.save ? this.store.eventsFile(run.id) : undefined,
        listener: options.onEvent,
      });
    } catch (error) {
      options.signal?.removeEventListener('abort', onExternalAbort);
      this.active.delete(run.id);
      run.status = 'failed';
      run.error = `Could not open the run event log: ${describeError(error)}`;
      run.finishedAt = new Date().toISOString();
      if (options.save) {
        await this.store.writeRun(run).catch(() => undefined);
      }
      this.logger.error(run.error);
      return;
    }

    let persists: Promise<void> = Promise.resolve();
    const persist = (): Promise<void> => {
      if (!options.save) {
        return Promise.resolve();
      }
      persists = persists.then(() => this.store.writeRun(run));
      return persists;
    };

    let runtimeContext: NodeRunContext | undefined;
    let jobs: JobRegistry | undefined;
    const stopJobs = async (reason: string): Promise<JobRecord[]> => {
      const stopped = jobs?.stopAll(reason) ?? [];
      if (jobs) {
        run.jobs = jobs.records();
      }
      return stopped;
    };

    try {
      const workspace = await Workspace.open(await this.store.createRunWorkspace(run.id));
      for (const file of options.seedFiles ?? []) {
        await fsp.copyFile(file, path.join(workspace.root, path.basename(file)));
      }

      timer = setTimeout(() => {
        budget.timedOut = true;
        controller.abort();
      }, this.config.runTimeoutMs);

      jobs = new JobRegistry({
        workspace,
        timeoutMs: this.config.jobTimeoutMs,
        runDeadline: Date.now() + this.config.runTimeoutMs,
        onEvent: ({ type, job }) => {
          run.jobs = jobs?.records();
          void sink.record(type, { nodeId: job.nodeId, payload: { ...job } }).catch(() => undefined);
        },
      });
      // A cancelled or timed-out run takes its jobs with it at once, not after the drain.
      controller.signal.addEventListener('abort', () => void stopJobs('the run was stopped'), { once: true });

      runtimeContext = {
        graph,
        run,
        workspace,
        sink,
        budget,
        runSignal: controller.signal,
        inFlight: new Set(),
        active: new Set(),
        persist,
        jobs,
      } satisfies NodeRunContext;
      const context = runtimeContext;

      const runtime: GraphRuntime = {
        runNode: (node, state, signal) => this.runNode(context, node, state, signal),
        onEdgeTaken: async (sourceId, targetId, branch) => {
          await sink.record('edge_taken', {
            nodeId: sourceId,
            payload: { sourceId, targetId, branch },
          });
        },
        onNodeSkipped: async (node) => {
          await sink.record('node_skipped', { nodeId: node.id, payload: { label: node.label } });
        },
      };

      const compiled = compileGraph(graph, runtime, controller.signal);
      const finalState = await compiled.invoke(
        { input },
        {
          signal: controller.signal,
          recursionLimit: graph.nodes.length + 1,
          maxConcurrency: this.config.maxParallelNodes,
        },
      );

      await settleWithin(context.inFlight, DRAIN_TIMEOUT_MS);
      // No node is left to hand a job to, so whatever still runs is stopped with the run.
      const stopped = await stopJobs('the run ended');
      if (stopped.length > 0) {
        this.logger.info(`Stopped ${stopped.length} background job(s) still running at the end: ${stopped.map((job) => job.id).join(', ')}.`);
      }
      run.outputs = finalState.outputs ?? run.outputs;
      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
      await sink.record('run_completed', {
        payload: { outputs: run.outputs, ...(stopped.length > 0 ? { jobsStopped: stopped.map((job) => job.id) } : {}) },
      });
    } catch (error) {
      const running = (jobs?.records() ?? []).filter((job) => job.status === 'running');
      await stopJobs('the run was stopped');
      if (runtimeContext) {
        await settleWithin(runtimeContext.inFlight, DRAIN_TIMEOUT_MS);
      }
      await this.recordFailure(run, graph, error, budget, controller, runtimeContext?.active ?? new Set(), sink, running);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onExternalAbort);
      this.active.delete(run.id);
      await stopJobs('the run ended');
      run.finishedAt ??= new Date().toISOString();
      const personOutput = personOutputOf(graph, run.outputs);
      if (personOutput) {
        run.personOutput = personOutput;
      }
      if (options.save) {
        await this.store.writeRun(run).catch((error: unknown) => {
          this.logger.error(`Could not persist run ${run.id}: ${describeError(error)}`);
        });
      }
      await sink.close();
      this.logger.info(`Run ${run.id} finished as ${run.status}.`);
    }
  }

  private async runNode(
    context: NodeRunContext,
    node: AgentNode,
    state: RunState,
    signal: AbortSignal,
  ): Promise<NodeResult> {
    const tracked = this.executeNode(context, node, state, signal);
    context.inFlight.add(tracked);
    try {
      return await tracked;
    } finally {
      context.inFlight.delete(tracked);
    }
  }

  private async executeNode(
    context: NodeRunContext,
    node: AgentNode,
    state: RunState,
    signal: AbortSignal,
  ): Promise<NodeResult> {
    const { graph, run, workspace, budget } = context;
    const branches = branchNames(graph, node.id);
    const meter = new UsageMeter(node.provider, node.model);

    context.active.add(node.id);
    await context.sink.record('node_started', { nodeId: node.id, payload: { label: node.label } });

    const labelOf = (id: string): string => graph.nodes.find((candidate) => candidate.id === id)?.label ?? id;
    const received = takenIncoming(graph, node.id, state).flatMap((edge) => state.jobs?.[edge.source] ?? []);
    const nodeJobs = new NodeJobs(context.jobs, node.id, received, labelOf);
    if (node.waitForJobs && nodeJobs.running().length > 0) {
      const waiting = nodeJobs.running().map((job) => job.id);
      const started = Date.now();
      await context.jobs.wait(waiting, context.jobs.runTimeLeftMs(), signal);
      signal.throwIfAborted();
      await context.sink.record('jobs_waited', {
        nodeId: node.id,
        payload: { jobs: waiting, seconds: Math.round((Date.now() - started) / 1000) },
      });
    }

    const limits = {
      bashTimeoutMs: this.config.bashTimeoutMs,
      bashTimeoutMaxMs: this.config.bashTimeoutMaxMs,
      outputLimitBytes: this.config.toolOutputLimitBytes,
      outputSaveLimitBytes: this.config.toolOutputSaveLimitBytes,
      outputStepLimitBytes: this.config.toolOutputStepLimitBytes,
      webFetchTimeoutMs: this.config.webFetchTimeoutMs,
      webFetchLimitBytes: this.config.webFetchLimitBytes,
    };
    const output = createToolOutput(node, workspace, limits);
    const email = await this.emailToolkit(node, output);
    const mcp = await this.mcpToolkit(node, output, signal);
    const toolkit = createNodeToolkit({ node, workspace, signal, email, mcp, output, limits, jobs: nodeJobs });

    try {
      const result = await runAgentLoop({
        nodeId: node.id,
        model: this.models.create(node),
        toolkit,
        systemPrompt: buildSystemPrompt(graph, node, handoffs(graph, node.id), {
          workspaceRoot: workspace.root,
          platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        }),
        inputMessage: buildNodeInput(graph, node, state) + (await handedJobsSection(node, nodeJobs)),
        branches,
        maxIterations: node.maxIterations ?? this.config.maxNodeIterations,
        signal,
        outputSchema: node.outputSchema,
        promptCaching: this.cachingApplies(node),
        meter,
        stepOutputLimitBytes: this.config.toolOutputStepLimitBytes,
        modelCallTimeoutMs: this.config.modelCallTimeoutMs,
        onModelTimeout: async (step) => {
          await context.sink.record('model_timeout', {
            nodeId: node.id,
            payload: { step, seconds: Math.round(this.config.modelCallTimeoutMs / 1000) },
          });
        },
        stepStatus: () => {
          const line = nodeJobs.statusLine();
          const jobsRunning = nodeJobs.running().length > 0;
          const left = context.jobs.runTimeLeftMs();
          const clock = jobsRunning || left < CLOCK_SHOWN_BELOW_MS ? [`run time left ${duration(left)}`] : [];
          return { parts: [...(line ? [line] : []), ...clock], jobsRunning };
        },
        onModelCall: async ({ reasoningText, ...call }) => {
          await context.sink.record('model_call', {
            nodeId: node.id,
            payload: { ...call, ...(reasoningText ? { reasoning: reasoningText.slice(0, MESSAGE_LOG_LIMIT) } : {}) },
          });
        },
        onOutputRejected: async (rejection) => {
          await context.sink.record('output_rejected', { nodeId: node.id, payload: { ...rejection } });
        },
        countStep: () => this.chargeStep(budget, node.id),
        runCallsLeft: () => Math.max(0, this.config.maxRunSteps - budget.steps),
        onMessage: async (text) => {
          await context.sink.record('agent_message', {
            nodeId: node.id,
            payload: { text: text.slice(0, MESSAGE_LOG_LIMIT) },
          });
        },
        onToolCall: async (call) => {
          await context.sink.record('tool_call', { nodeId: node.id, payload: { ...call } });
        },
      });

      run.outputs[node.id] = result.output;
      const handedOn = nodeJobs.running().map((job) => job.id);
      if (handedOn.length > 0) {
        this.logger.info(`"${node.label}" handed on running background jobs: ${handedOn.join(', ')}.`);
      }
      if (result.stoppedEarly) {
        run.stoppedEarlyNodes = [...new Set([...(run.stoppedEarlyNodes ?? []), node.id])];
        this.logger.info(`"${node.label}" ran out of model calls and handed over a partial result.`);
      }
      const recorded = this.recordUsage(run, node, meter);
      await context.sink.record('node_completed', {
        nodeId: node.id,
        payload: {
          output: result.output,
          next: result.next,
          usage: recorded,
          ...(result.stoppedEarly ? { stoppedEarly: true } : {}),
          ...(handedOn.length > 0 ? { jobs: handedOn } : {}),
        },
      });
      await context.persist();

      return { ...result, ...(handedOn.length > 0 ? { jobs: handedOn } : {}) };
    } catch (error) {
      await context.sink.record('node_failed', {
        nodeId: node.id,
        payload: { error: describeError(error), reason: failureReason(context, signal) },
      });
      throw error;
    } finally {
      if (meter.iterations > 0) {
        this.recordUsage(run, node, meter);
      }
      context.active.delete(node.id);
      // The mailbox socket and the MCP server (and any browser it launched) belong to this node run, not to the executor.
      await email?.dispose();
      await mcp?.dispose();
    }
  }

  /**
   * Records what a node spent against its own model, then re-derives the run
   * total. A call that could not be priced keeps its tokens and blocks
   * `costUsd` instead of quietly understating it: the run names what it could
   * not price.
   */
  private recordUsage(run: Run, node: AgentNode, meter: UsageMeter): NodeUsage {
    const spent = meter.summary();
    const entry: NodeUsage = {
      input: spent.input,
      output: spent.output,
      total: spent.total,
      iterations: meter.iterations,
      model: node.model,
      ...(spent.cacheRead > 0 ? { cacheRead: spent.cacheRead } : {}),
      ...(spent.cacheWrite > 0 ? { cacheWrite: spent.cacheWrite } : {}),
      ...(spent.reasoning > 0 ? { reasoning: spent.reasoning } : {}),
      ...(spent.usd !== undefined ? { usd: spent.usd, costSource: spent.costSource } : {}),
      ...(spent.upstreamUsd !== undefined ? { upstreamUsd: spent.upstreamUsd } : {}),
      ...(spent.usd === undefined ? { unpriced: spent.unpriced ?? node.model } : {}),
    };
    run.usage ??= {};
    run.usage[node.id] = entry;

    const recorded = Object.values(run.usage);
    const blocked = [
      ...new Set(recorded.filter((row) => row.usd === undefined).map((row) => row.unpriced ?? row.model ?? 'unknown')),
    ];
    const pricedUsd = recorded.reduce((sum, row) => sum + (row.usd ?? 0), 0);
    run.costUsd = blocked.length === 0 ? pricedUsd : undefined;
    run.unpricedModels = blocked.length > 0 ? blocked : undefined;
    run.pricesAsOf = recorded.some((row) => row.costSource === 'list-price') ? PRICES_AS_OF : undefined;

    return entry;
  }

  /** Prompt caching is only claimed where the provider passes the marker through. */
  private cachingApplies(node: AgentNode): boolean {
    // ChatAnthropic forwards a top-level `cache_control` on text blocks; the
    // OpenAI-compatible path (including OpenRouter) does not, so it is left off
    // rather than risking a malformed request for no caching benefit.
    return node.provider === 'anthropic';
  }

  private chargeStep(budget: RunBudget, nodeId: string): void {
    budget.steps += 1;
    if (budget.steps > this.config.maxRunSteps) {
      throw new NodeFailureError(`The run hit its limit of ${this.config.maxRunSteps} steps.`, nodeId);
    }
  }

  /**
   * The node's mailbox tools, or undefined when it holds no email permission. A
   * node that needs the mailbox but cannot have it fails here, before any model
   * call.
   */
  private async emailToolkit(node: AgentNode, output: ToolOutput): Promise<EmailToolkit | undefined> {
    if (!usesEmail(node.permissions)) {
      return undefined;
    }

    await this.assertMailboxReady(node);

    const connection = this.email.open();
    if (!connection) {
      throw new NodeFailureError(
        `Node "${node.label}" needs mailbox access, but no mailbox is configured. Set LEAFI_EMAIL_ADDRESS and LEAFI_EMAIL_APP_PASSWORD in the environment.`,
        node.id,
      );
    }

    return createEmailToolkit({
      permissions: node.permissions,
      connection,
      output,
    });
  }

  /**
   * A node that needs the mailbox fails before its first token is spent. An app
   * password has no "connected" state to inspect, so this is a real login.
   */
  private async assertMailboxReady(node: AgentNode): Promise<void> {
    try {
      await this.email.assertReady();
    } catch (error) {
      throw new NodeFailureError(`Node "${node.label}" needs mailbox access. ${describeError(error)}`, node.id);
    }
  }

  /**
   * An mcp node gets its own MCP server. With the default browser server that
   * means its own Chrome: the pages it opens are its context, and a sibling
   * running at the same time cannot navigate them out from under it.
   */
  private async mcpToolkit(node: AgentNode, output: ToolOutput, signal: AbortSignal): Promise<McpToolkit | undefined> {
    if (!node.permissions.mcp) {
      return undefined;
    }

    try {
      return await createMcpToolkit({
        command: this.config.mcpCommand,
        dataDir: this.config.dataDir,
        timeoutMs: this.config.mcpTimeoutMs,
        output,
        allowlist: this.config.mcpTools,
        signal,
      });
    } catch (error) {
      throw new NodeFailureError(
        `Node "${node.label}" needs the MCP server, but it could not start. ${describeError(error)} ` +
          `Set LEAFI_MCP_COMMAND in the environment to an MCP server launcher, such as chrome-devtools-mcp for a browser (current: ${this.config.mcpCommand}).`,
        node.id,
      );
    }
  }

  private async recordFailure(
    run: Run,
    graph: Graph,
    error: unknown,
    budget: RunBudget,
    controller: AbortController,
    active: Set<string>,
    sink: RunEventSink,
    runningJobs: JobRecord[] = [],
  ): Promise<void> {
    if (controller.signal.aborted) {
      if (budget.timedOut) {
        const labels = [...active].map((id) => graph.nodes.find((node) => node.id === id)?.label ?? id);
        run.status = 'failed';
        run.error = `The run exceeded its ${Math.round(this.config.runTimeoutMs / 60_000)} minute time limit.${
          labels.length > 0 ? ` Nodes still running: ${labels.join(', ')}.` : ''
        }${
          runningJobs.length > 0
            ? ` Background jobs stopped: ${runningJobs.map((job) => `${job.id} (${job.command.slice(0, 80)})`).join(', ')}.`
            : ''
        }`;
        run.failedNodeId = labels.length > 0 ? [...active][0] : undefined;
        await sink.record('run_failed', {
          nodeId: run.failedNodeId,
          payload: { error: run.error },
        });
        return;
      }

      run.status = 'cancelled';
      run.error = 'Cancelled by the user.';
      await sink.record('run_cancelled', {});
      return;
    }

    const failure = findNodeFailure(error);
    run.status = 'failed';
    run.error = failure?.message ?? describeError(error);
    run.failedNodeId = failure?.nodeId ?? [...active][0];
    await sink.record('run_failed', { nodeId: run.failedNodeId, payload: { error: run.error } });
  }
}

/**
 * What a node is told about the jobs handed to it, written by the runtime from
 * each job's live record, so a producer's "it will be written" can never stand
 * in for the job's actual state.
 */
async function handedJobsSection(node: AgentNode, jobs: NodeJobs): Promise<string> {
  const held = jobs.jobs();
  if (held.length === 0) {
    return '';
  }
  const control = node.permissions.bash
    ? 'They are yours now: check on them with job_status, wait for them with wait_job (one call waits until they end), or end them with stop_job.'
    : 'You hold no shell tools, so you cannot wait on or stop them; they are handed on when you finish, and stopped when the run ends.';
  const lines = ['', '', '# Background jobs handed to you', control];
  for (const job of held) {
    lines.push(`- ${jobs.describe(job)}`);
    if (job.status !== 'running') {
      const tail = await jobs.registry.tail(job.id, HANDED_JOB_TAIL_BYTES);
      if (tail) {
        lines.push('  End of log:', ...tail.split('\n').map((line) => `  ${line}`));
      }
    }
  }
  return lines.join('\n');
}

function personOutputOf(
  graph: Graph,
  outputs: Record<string, string>,
): Run['personOutput'] {
  for (const node of graph.nodes) {
    const output = outputs[node.id];
    if (node.audience === 'person' && output !== undefined) {
      return { nodeId: node.id, output };
    }
  }
  return undefined;
}

interface NodeRunContext {
  graph: Graph;
  run: Run;
  workspace: Workspace;
  sink: RunEventSink;
  budget: RunBudget;
  runSignal: AbortSignal;
  /** Node runs still unwinding; drained before the run's final event. */
  inFlight: Set<Promise<unknown>>;
  /** Nodes currently in their agent loop, for timeout attribution. */
  active: Set<string>;
  /** Serializes snapshot writes so an older one can never land last. */
  persist(): Promise<void>;
  /** The run's background jobs. */
  jobs: JobRegistry;
}

function failureReason(context: NodeRunContext, nodeSignal: AbortSignal): string {
  if (context.runSignal.aborted) {
    return 'cancelled';
  }
  return nodeSignal.aborted ? 'aborted' : 'failed';
}

async function settleWithin(promises: Set<Promise<unknown>>, timeoutMs: number): Promise<void> {
  if (promises.size === 0) {
    return;
  }
  await Promise.race([
    Promise.allSettled([...promises]),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
