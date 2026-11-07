# leafi Hermes plugin

Lets Hermes design and run leafi flows. The MCP server is bundled in
`dist/server.mjs`, so the only runtime requirement is Node.js 22 or newer.

## Install

You need Hermes, Git and Node.js 22 or newer. The installer shows a checklist
of the agents it finds; with Hermes ticked, it installs and enables the plugin.
It asks for a provider key and which permissions flows may use first (see
[Configuration](#configuration)). Running it again repeats the setup.

```bash
curl -fsSL https://raw.githubusercontent.com/Bruce-Hopkins/leafi/main/install.sh | sh
```

On Windows, in PowerShell:


```shell
irm https://raw.githubusercontent.com/Bruce-Hopkins/leafi/main/install.ps1 | iex
```



## Manual Installation

Run this command to install the plugin

```bash
hermes plugins install Bruce-Hopkins/leafi/hermes-plugin --enable
node ~/.hermes/plugins/leafi/dist/server.mjs init
```

And then restart Hermes.

**Update** with:

```bash
hermes plugins update leafi
```

## Configuration

The plugin reads Hermes's own `.env` (with a Hermes profile, set `HERMES_HOME`
to its folder first), not the CLI's `~/.leafi/.env`.


| To                          | Run                                                                  |
| --------------------------- | -------------------------------------------------------------------- |
| Set the key and permissions | `node ~/.hermes/plugins/leafi/dist/server.mjs init`     |
| Change only the permissions | `node ~/.hermes/plugins/leafi/dist/server.mjs settings` |
| Edit the file by hand       | Copy from [`.env.example`](../.env.example)                          |


Both commands show a checklist: arrow keys, space to tick, Enter to save. `web`
and `write` start ticked; `bash`, `email` and `mcp` start unticked, and a
flow that needs one asks you for it when it starts. After any change, start a
new Hermes session.

## Using it

Ask Hermes for the automation you want, as an outcome rather than a flow. It
designs a flow, validates it for free, and shows you a drawing naming each
node's model, with the expected cost (the minimum tokens the flow implies;
nodes that loop use more). Once you agree, it starts the run, which Hermes asks
you to confirm, and gives you the result with its actual cost.

A run's files are in
`~/.hermes/plugin-data/agent-plugin-leafi-<id>/workspaces/<runId>/`.

## Trust

The plugin is marked `trust: untrusted`, so Hermes asks before the two tools
that change state, `start_run` and `cancel_run`; the rest are read-only. That
is a confirmation, not a sandbox: once started, a flow can do whatever its
permissions allow. See [`SECURITY.md`](../SECURITY.md).