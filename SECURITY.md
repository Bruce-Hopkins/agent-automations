# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability
reporting:
<https://github.com/Bruce-Hopkins/leafi/security/advisories/new>.
Do not open a public issue for a security problem. Include the version
(`package.json`), the flow or command that shows the problem, and what you
expected to happen instead.

Only the latest release is supported with security fixes.

## The security model

`leafi` runs LLM agents on your machine, as you. It is not a sandbox. The
permissions on each node decide which tools that node's model can call, and the
model decides what to do with them.

### What each permission allows

| Permission | What it really allows |
| --- | --- |
| `read`, `write` | `read_file` / `write_file` inside the run's own workspace (`<data dir>/workspaces/<runId>/`). Paths that leave it, through `..` or symlinks, are refused. |
| `bash` | `run_bash`: any command you could run yourself. It starts in the workspace but can read and change any file you can, and reach any network address. Child processes get an allowlist environment, so provider keys and the mailbox password are not passed on, but nothing stops a command from reading files that contain them. A word check rejects commands that name `sudo`, `su` or `doas`; it is a speed bump, and quoting (`s''udo`) gets past it. On timeout or cancellation the whole process group is killed. |
| `web` | `web_fetch` of http(s) URLs. Loopback, private, link-local (including the `169.254.169.254` cloud metadata address), carrier-grade NAT, multicast and other reserved ranges are refused, in IPv4, IPv6, IPv4-mapped IPv6 (`::ffff:127.0.0.1`), NAT64, 6to4 and Teredo forms. The check runs on the address the connection actually uses, so DNS rebinding does not get around it, and a name that does not resolve is refused. |
| `email_read` | Searching and reading the one configured mailbox over IMAP with TLS. The mailbox is opened read-only (`EXAMINE`) and messages are fetched with `BODY.PEEK`, so nothing is changed or marked as read. There is no send tool. |
| `mcp` | The tools of the MCP server set by `LEAFI_MCP_COMMAND`, limited to `LEAFI_MCP_TOOLS`. By default that is a real headless Chrome driven through chrome-devtools-mcp. This CLI does not sandbox the server, and the default browser **can** reach local and private addresses that `web_fetch` refuses; another server can do whatever its program does. The server runs with a private home at `<data dir>/mcp-home`, which must be owned by you and closed to other accounts. |

The MCP server refuses flows that request `bash`, `write`,
`web`, `email_read` or `mcp` unless the matching `LEAFI_ALLOW_*` setting is
`true`. The installer's setup offers `web` and `write` ticked and `bash`,
`email_read` and `mcp` unticked. When a flow needs a permission that is
off, the server asks you through your MCP client before it starts, naming the
nodes that want it; the agent cannot answer that question. You can allow it for
that run, or always, which saves the setting. A client that cannot show the
question gets a refusal naming the `settings --allow` command instead. Its
`flowPath` argument can open any file you can read, but only reports whether it
exists and is a valid flow.

### Untrusted content steers agents

Text a node reads — web pages, emails, browser pages, files from the internet —
can contain instructions, and models follow them (prompt injection). Treat a
node that reads untrusted content as untrusted:

- Do not give it `bash` or `write` as well. Split the flow so the reading node
  hands a summary to a node that holds the dangerous permission, or leave that
  permission out.
- Be careful combining `email_read` with `web` or `mcp`: an email could ask
  the agent to send what it read to an outside address.
- Read flows you did not write before running them, and check each node's
  permissions in the drawing your agent shows you (the `render_flow` tool), or
  with `leafi graph --graph flow.json` from a clone.

### Settings and secrets

- The Hermes plugin's settings come from Hermes's `.env`. Everything else reads
  `~/.leafi/.env` (the data directory's `.env`), or the file
  `--env-file` names. A `.env` in the current directory is never read on its
  own, so a downloaded project cannot change your settings by shipping one.
  Keep these files owner-only (`chmod 600`).
- Provider requests always go to each provider's official address; variables
  such as `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and `LANGSMITH_GATEWAY` are
  ignored.
- LangChain/LangSmith tracing is switched off unless
  `LEAFI_LANGSMITH_TRACING=true`, because a trace uploads every prompt,
  tool result and email excerpt.
- `LEAFI_MCP_COMMAND` is a program that runs whenever an `mcp` node starts.
  The default is pinned to an exact `chrome-devtools-mcp` version; if you
  change it, pin a version too.
- A value that is still an unexpanded `${VAR}` placeholder counts as unset.

### Run records

The data directory holds run inputs, outputs, tool calls and email excerpts. It
is created owner-only (`0700` folders, `0600` files). Anyone who can read it can
read what your runs saw.
