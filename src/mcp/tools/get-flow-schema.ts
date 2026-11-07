import { z } from "zod";
import { DESIGN_GUIDE } from "../../app/design-guide";
import { FLOW_SCHEMA } from "../../app/flow-schema";
import type { McpContext } from "../context";
import type { ToolDefinition } from "./types";

const inputSchema = z.object({});

export const getFlowSchemaTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "get_flow_schema",
  description:
    'Return the JSON Schema for a leafi flow document, plus "designGuide": the rules for choosing node boundaries, tiers and wiring. Read the guide before authoring a flow.',
  inputSchema,
  annotations: { readOnlyHint: true },
  async handle(_input, context: McpContext) {
    // The guide rides along: this is the one call every author makes before
    // writing a flow, and an MCP client that only sees tool results (Hermes)
    // has no other path to the design rules.
    return context.results.json({ ...FLOW_SCHEMA, designGuide: DESIGN_GUIDE });
  },
};
