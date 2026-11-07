import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP lists tools and validates the example", {
  timeout: 20000,
}, async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "leafi-mcp-test-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve("dist/mcp/main.js"),
      "--transport",
      "stdio",
      "--data-dir",
      dataDir,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "leafi-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "validate_flow"));
    const schemaTool = tools.tools.find(
      (tool) => tool.name === "get_flow_schema",
    );
    assert.match(schemaTool?.description ?? "", /designGuide/);

    const schema = await client.callTool({
      name: "get_flow_schema",
      arguments: {},
    });
    const contract = JSON.parse(textOf(schema.content));
    assert.equal(contract.type, "object");
    assert.match(contract.designGuide, /designing a flow/i);

    const example = await client.callTool({
      name: "get_example_flow",
      arguments: {},
    });
    const flow = JSON.parse(textOf(example.content));

    const validation = await client.callTool({
      name: "validate_flow",
      arguments: { flow },
    });
    const body = JSON.parse(textOf(validation.content));
    assert.equal(body.ok, true);
    assert.equal(body.estimate, undefined);
    assert.match(body.minimum.note, /lower bound, not a forecast/);
    for (const node of flow.nodes) {
      assert.ok(body.diagram.includes(`${node.label} · ${node.model}`), body.diagram);
    }
    assert.match(body.reply, /Show "diagram" to the user/);

    const cyclic = {
      name: "cycle",
      nodes: ["a", "b"].map((id) => ({ id, label: id.toUpperCase(), provider: "openai", model: "gpt-4o-mini", prompt: "p" })),
      edges: [{ source: "a", target: "b" }, { source: "b", target: "a" }],
    };
    const broken = JSON.parse(textOf((await client.callTool({ name: "validate_flow", arguments: { flow: cyclic } })).content));
    assert.equal(broken.ok, false);
    assert.ok(broken.issues.length > 0);
    assert.match(broken.diagram, /\[A · gpt-4o-mini\]/);

    for (const name of ["validate_flow", "render_flow", "start_run"]) {
      const description = tools.tools.find((tool) => tool.name === name)?.description ?? "";
      assert.match(description, /diagram|drawing/, name);
    }
  } finally {
    await client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
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
