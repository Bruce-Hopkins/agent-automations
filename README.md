# leafi

Run precise, efficient, multi-step automations made of LLM agents linked together. Let your agent create a saved flow for you, and let your agent use it reliably whenever needed.

This is a prototype, but new updates are coming soon. Star the project to receive updates on the progress!

## Install

To install on Hermes, Claude Code, or Cursor, you need Node.js 22 or newer. On macOS, Linux or WSL2:

```bash
curl -fsSL https://raw.githubusercontent.com/Bruce-Hopkins/leafi/main/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Bruce-Hopkins/leafi/main/install.ps1 | iex
```

You can ask any agent to use the project:

> Use leafi to find this month's most-cited arXiv papers on small code
> models and brief me on them in a few paragraphs. You may use web, not bash.

### Install Manually

With Hermes, on macOS and Linux:

```bash
hermes plugins install Bruce-Hopkins/leafi/hermes-plugin --enable
node ~/.hermes/plugins/leafi/dist/server.mjs init
```

On Windows, in PowerShell:

```powershell
hermes plugins install Bruce-Hopkins/leafi/hermes-plugin --enable
node "$env:LOCALAPPDATA\hermes\plugins\leafi\dist\server.mjs" init
```

For another MCP client, download the server (a single file) and run its setup:

```bash
mkdir -p -m 700 ~/.leafi
curl -fsSL -o ~/.leafi/server.mjs https://raw.githubusercontent.com/Bruce-Hopkins/leafi/main/hermes-plugin/dist/server.mjs
node ~/.leafi/server.mjs init
```

`init` is the installer's setup, with the same checklist. It ends by printing
the entry to paste into your client's `mcpServers`. To fill in the settings by
hand instead, copy from [`.env.example`](.env.example).

### Changing permissions later

`bash`, `email` and `mcp` start off. When a flow needs one, you're asked
before it runs, and can allow it once or always. To change them yourself, run
the server with `settings`, then restart Hermes or your client. It changes the
permissions for every agent you installed into:

```bash
leafi settings
```

If you installed by hand, run `node <server> settings` instead, where the
server is `~/.leafi/server.mjs`, or
`~/.hermes/plugins/leafi/dist/server.mjs` for the Hermes plugin.

[`hermes-plugin/README.md`](hermes-plugin/README.md) covers updating the plugin
and what happens during a run.

### Coming from agents-automations

leafi was called agents-automations until 0.0.3. Run the installer again and it
moves `~/.agents-automations` to `~/.leafi`, with your settings, saved flows and
runs, and replaces the old entry in each agent you tick in its checklist. The
old `agents-automations` command keeps working and runs leafi.

Settings named `AGENTS_AUTOMATIONS_*` are still read, with a warning, as their
`LEAFI_*` names. `leafi settings` renames them in every settings file it
manages, Hermes's `.env` included. The Hermes plugin passes on only the new
names, so run it once after installing the plugin. Then remove the old plugin
with `hermes plugins remove agents-automations`, after copying any saved flows
you want from its data folder.

## Security

A node with `bash` can run any command you can, and an `mcp` node (a headless
Chrome by default) can reach your local network: neither is sandboxed. Text from web pages and emails can
steer an agent, so a node that reads untrusted content should not also hold
`bash` or `write`. Read [`SECURITY.md`](SECURITY.md) before running a flow you
did not write; it also explains how to report a vulnerability.


## Development

To work from source, you also need pnpm:

```bash
git clone https://github.com/Bruce-Hopkins/leafi.git
cd leafi
pnpm install
pnpm build
node dist/main.js --help     # or: pnpm cli --help, which builds first
pnpm build:plugin            # bundles the CLI and the server into hermes-plugin/dist/server.mjs
pnpm add -g "link:$PWD"      # optional: put this checkout on your PATH
```

`pnpm cli` and `pnpm dev` read the same settings as the installed CLI,
`~/.leafi/.env`. The checks:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:plugin   # builds and exercises the bundled Hermes server
pnpm test:pack     # packs the npm tarball, installs it and runs every command
```

Hermes doesn't build the plugin when it installs it, so after changing the
server, run `pnpm build:plugin` and commit `hermes-plugin/dist/`. Before a
release, `hermes plugins validate ./hermes-plugin --json` must pass.
