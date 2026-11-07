import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tempDirs: string[] = [];

/** A fresh temp directory, removed when this file's tests finish. */
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const pluginDir = path.resolve("hermes-plugin");
const bundle = path.join(pluginDir, "dist", "server.mjs");

test("plugin metadata is portable and secret-free", () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf8"),
  );
  const mcp = JSON.parse(
    fs.readFileSync(path.join(pluginDir, "mcp.json"), "utf8"),
  );

  assert.equal(
    plugin.$schema,
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  );
  assert.equal(
    mcp.$schema,
    "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  );
  assert.equal(plugin.name, "leafi");
  assert.equal(plugin.version, JSON.parse(fs.readFileSync("package.json", "utf8")).version);
  assert.equal(plugin.license, "MIT");
  assert.equal(
    plugin.extensions["com.nousresearch.hermes"].servers["leafi"].trust,
    "untrusted",
  );

  const server = mcp.mcpServers["leafi"];
  assert.equal(Object.keys(mcp.mcpServers)[0], plugin.name);
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, [
    "${PLUGIN_ROOT}/dist/server.mjs",
    "--transport",
    "stdio",
    "--no-env",
  ]);
  assert.equal(server.env.LEAFI_HOME, "${PLUGIN_DATA}");
  assert.equal(server.env.OPENAI_API_KEY, "${OPENAI_API_KEY}");
  assert.equal(server.env.ANTHROPIC_API_KEY, "${ANTHROPIC_API_KEY}");
  assert.equal(server.env.GOOGLE_API_KEY, "${GOOGLE_API_KEY}");
  assert.equal(server.env.OPENROUTER_API_KEY, "${OPENROUTER_API_KEY}");

  const files = [
    "plugin.json",
    "mcp.json",
    "README.md",
    "after-install.md",
    "skills/leafi/SKILL.md",
  ];
  for (const file of files) {
    const content = fs.readFileSync(path.join(pluginDir, file), "utf8");
    assert.doesNotMatch(
      content,
      /sk-[A-Za-z0-9]{20,}/,
      `${file} contains a literal secret`,
    );
    assert.doesNotMatch(
      content,
      /(password|token|secret)\s*[:=]\s*["'][^"'$]+["']/i,
      `${file} contains a literal secret`,
    );
  }

  // The description is the only signal Hermes gets before loading the skill, so
  // it has to name designing a flow, not just validating and running one.
  const skill = fs.readFileSync(
    path.join(pluginDir, "skills/leafi/SKILL.md"),
    "utf8",
  );
  const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
  assert.match(
    description,
    /design/i,
    "skill description must match a flow-design task",
  );
  assert.ok(
    description.length <= 1024,
    "skill description must fit the portable plugin limit",
  );
});

test("bundled MCP server serves inspection tools and rejects dangerous flows", {
  timeout: 30000,
}, async () => {
  assert.ok(fs.existsSync(bundle), "run pnpm build:plugin before this test");

  const root = makeTempDir("leafi-plugin-test-");
  const cwd = path.join(root, "cwd");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, ".env"), "LEAFI_ALLOW_BASH=true\n");

  const env = { ...process.env };
  delete env.LEAFI_ALLOW_BASH;
  delete env.LEAFI_ALLOW_WRITE;
  delete env.LEAFI_ALLOW_WEB;
  delete env.LEAFI_ALLOW_EMAIL;
  delete env.LEAFI_ALLOW_MCP;
  env.LEAFI_HOME = dataDir;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle, "--transport", "stdio", "--no-env"],
    cwd,
    env: env as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({
    name: "leafi-plugin-test",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const readOnly = tools.tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name);
    assert.deepEqual(readOnly.sort(), [
      "get_example_flow",
      "get_flow",
      "get_flow_schema",
      "get_run",
      "get_run_events",
      "list_flows",
      "list_providers",
      "list_runs",
      "render_flow",
      "validate_flow",
    ]);

    const example = await client.callTool({
      name: "get_example_flow",
      arguments: {},
    });
    const flow = JSON.parse(textOf(example.content));
    const validation = await client.callTool({
      name: "validate_flow",
      arguments: { flow },
    });
    assert.equal(JSON.parse(textOf(validation.content)).ok, true);

    // Hermes only ever sees tool results, so the design guide must arrive here.
    const schema = await client.callTool({
      name: "get_flow_schema",
      arguments: {},
    });
    const contract = JSON.parse(textOf(schema.content));
    assert.equal(contract.type, "object", "the schema itself is unchanged");
    assert.match(
      contract.designGuide,
      /A node is a context boundary, not a step/,
    );
    assert.match(contract.designGuide, /json-via-web-fetch/);

    const rendering = await client.callTool({
      name: "render_flow",
      arguments: { flow },
    });
    assert.match(textOf(rendering.content), /./);

    const providers = await client.callTool({
      name: "list_providers",
      arguments: {},
    });
    assert.ok(textOf(providers.content).length > 0);

    const denied = await client.callTool({
      name: "start_run",
      arguments: {
        flow: {
          name: "denied",
          nodes: [
            {
              id: "fetch",
              label: "Fetch",
              provider: "openai",
              model: "gpt-4o-mini",
              prompt: "Fetch a page.",
              permissions: { bash: true },
            },
          ],
          edges: [],
        },
      },
    });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied.content), /policy denies this flow/i);
  } finally {
    await client.close();
  }
});

test("after-install.md points at the bundled init where Hermes installs it", () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf8"),
  );
  const mcp = JSON.parse(
    fs.readFileSync(path.join(pluginDir, "mcp.json"), "utf8"),
  );
  const afterInstall = fs.readFileSync(
    path.join(pluginDir, "after-install.md"),
    "utf8",
  );

  // Hermes shows this file once, right after `hermes plugins install`; it runs
  // no plugin code, so the command it names is the whole setup step.
  const serverPath = String(mcp.mcpServers["leafi"].args[0]).replace(
    "${PLUGIN_ROOT}",
    `~/.hermes/plugins/${plugin.name}`,
  );
  assert.ok(afterInstall.includes(`node ${serverPath} init`));
});

test("bundled init refuses to run without a terminal, and installs and writes nothing", {
  timeout: 15000,
}, () => {
  assert.ok(fs.existsSync(bundle), "run pnpm build:plugin before this test");
  const dir = makeTempDir("leafi-plugin-init-");
  const hermesHome = path.join(dir, "hermes");
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(path.join(hermesHome, "plugins", "leafi"), { recursive: true });

  const result = spawnSync(process.execPath, [bundle, "init"], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, HERMES_HOME: hermesHome, LEAFI_HOME: dataDir, DATA_DIR: "" },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /needs a\s+terminal\. Nothing was installed or changed/);
  assert.ok(result.stderr.includes(`node "${bundle}" init`), result.stderr);
  assert.equal(fs.existsSync(dataDir), false);
  assert.equal(fs.existsSync(path.join(hermesHome, ".env")), false);
});

test("bundle writes no logs to stdout", { timeout: 15000 }, async () => {
  assert.ok(fs.existsSync(bundle), "run pnpm build:plugin before this test");
  const result = await runWithoutInput(bundle);
  assert.equal(result.stdout, "");
  assert.equal(result.code, 0);
});

test("bundle runs the CLI's flow commands, so it is also the leafi command", {
  timeout: 15000,
}, () => {
  assert.ok(fs.existsSync(bundle), "run pnpm build:plugin before this test");
  const env = { ...process.env, LEAFI_HOME: makeTempDir("leafi-plugin-cli-"), DATA_DIR: "" };
  const cli = (args: string[], input = "") =>
    spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", input, env });

  const example = cli(["schema", "example"]);
  assert.equal(example.status, 0, example.stderr);
  const validated = cli(["validate", "--graph", "-"], example.stdout);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).ok, true);

  const drawn = cli(["graph", "--graph", "-", "--format", "mermaid"], example.stdout);
  assert.equal(drawn.status, 0, drawn.stderr);
  assert.match(drawn.stdout, /flowchart|graph/);

  // CLI errors keep the CLI's exit codes and help.
  const usage = cli(["run", "--bogus"]);
  assert.equal(usage.status, 3);
  assert.match(usage.stderr, /Unknown flag "--bogus"/);
  assert.match(cli(["run", "--help"]).stdout, /leafi run --graph/);
  const misordered = cli(["--data-dir", env.LEAFI_HOME, "run", "--bogus"]);
  assert.equal(misordered.status, 3, "a bad flag after a flag value still gets the CLI's usage error");
  assert.match(misordered.stderr, /Unknown flag "--bogus"/);
  const typo = cli(["valdate"]);
  assert.equal(typo.status, 3);
  assert.match(typo.stderr, /Unknown command "valdate"/);

  // The server's own entry points are unchanged.
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /leafi <validate\|schema\|graph\|run\|runs\|providers>/);
  assert.match(help.stdout, /leafi init/);
  assert.equal(cli(["--version"]).stdout.trim(), JSON.parse(fs.readFileSync("package.json", "utf8")).version);
});

function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const first = content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    return "";
  }
  return first.text;
}

function runWithoutInput(
  command: string,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [command, "--transport", "stdio", "--no-env"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          LEAFI_HOME: makeTempDir("leafi-plugin-io-"),
        },
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, code }));
  });
}
