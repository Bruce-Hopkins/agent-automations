/**
 * The settings file `leafi init` writes. Keep it in step with
 * `.env.example`; a test checks both name the same variables.
 */
export const ENV_TEMPLATE = `# Written by "leafi init". Settings for every leafi command.
# Variables already set in the shell take precedence over this file.

# Provider keys: set at least one. A node can only use a model whose provider
# has a key. In Hermes, an OAuth or subscription login is not a key: the plugin
# needs one of these.
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
OPENROUTER_API_KEY=

# Permissions: the tools a flow started over MCP (from Hermes, Claude Desktop,
# Cursor ...) may use. Flows run with \`leafi run\` are not limited by
# these. \`leafi settings\` changes them for you; a line left out keeps the
# value shown.
#   web         web_fetch
#   write       write_file, inside the run workspace
#   bash        run_bash: any command you can run
#   email       the read-only mailbox tools (needs the mailbox below)
#   mcp         tools from an MCP server (the launcher below; a headless Chrome
#               by default)
#   flow-paths  passing a flow as a file path instead of inline JSON
# LEAFI_ALLOW_WEB=false
# LEAFI_ALLOW_WRITE=false
# LEAFI_ALLOW_BASH=false
# LEAFI_ALLOW_EMAIL=false
# LEAFI_ALLOW_MCP=false
# LEAFI_ALLOW_FLOW_PATHS=true

# Mailbox, for email nodes: read-only, over IMAP, with an app password. Gmail
# offers one once 2-Step Verification is on; the account password never works.
# With the address or password empty, agents get no email tools.
LEAFI_EMAIL_ADDRESS=
LEAFI_EMAIL_APP_PASSWORD=
LEAFI_EMAIL_IMAP_HOST=imap.gmail.com
LEAFI_EMAIL_IMAP_PORT=993
# LEAFI_EMAIL_TIMEOUT_MS=20000

# Nodes holding the mcp permission start this MCP server launcher and may call
# only the tools listed. The default is a headless Chrome (chrome-devtools-mcp)
# with its read-and-navigate tools; to use another MCP server, set both the
# command and its tool names. Pin an exact version: upgrade it on purpose, after
# reading its notes.
# LEAFI_MCP_COMMAND=npx -y chrome-devtools-mcp@1.10.1 --headless --isolated
# LEAFI_MCP_TOOLS=new_page,navigate_page,take_snapshot,evaluate_script,list_pages,wait_for,click,type_text,press_key
# LEAFI_MCP_TIMEOUT_MS=120000

# ---- Everything below is for ~/.leafi/.env only; Hermes ignores it. ----

# Extra environment variables to forward to \`run_bash\` and MCP servers.
# Everything else is filtered out, so list only names a tool genuinely needs.
# AGENT_ENV_PASSTHROUGH=HTTP_PROXY,HTTPS_PROXY

# Run guardrails.
MAX_NODE_ITERATIONS=25
MAX_RUN_STEPS=200
MAX_PARALLEL_NODES=4
RUN_TIMEOUT_MS=1800000
# How long a shell command runs (2 minutes by default); a node may ask for up
# to BASH_TIMEOUT_MAX_MS (10 minutes) with timeoutSeconds.
# BASH_TIMEOUT_MS=120000
# BASH_TIMEOUT_MAX_MS=600000
# The longest a background job (run_bash with background: true) may run.
# JOB_TIMEOUT_MS=1800000
# How long one model call may take; it is retried once, then the node fails.
# MODEL_CALL_TIMEOUT_MS=300000
# The most one tool result returns to the model (32 KiB by default).
# BASH_OUTPUT_LIMIT_BYTES=32768
# A result over that cap is saved to the workspace, up to this many bytes, and
# the node reads on from the file in pieces.
# TOOL_OUTPUT_SAVE_LIMIT_BYTES=1048576
# The most all tool results of one model response return together.
# TOOL_OUTPUT_STEP_LIMIT_BYTES=131072
WEB_FETCH_TIMEOUT_MS=20000
WEB_FETCH_LIMIT_BYTES=262144

# LangChain/LangSmith tracing uploads every prompt and tool result, so its
# variables (LANGSMITH_TRACING, ...) are ignored unless this is true.
# LEAFI_LANGSMITH_TRACING=false

# Runtime state. Defaults to ~/.leafi.
# LEAFI_HOME=
# DATA_DIR=

# Limits for leafi-mcp.
# MCP_MAX_CONCURRENT_RUNS=2
# MCP_MAX_FLOW_BYTES=262144
# MCP_MAX_RESULT_BYTES=262144
`;
