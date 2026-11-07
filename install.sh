#!/bin/sh
# Installs leafi on macOS, Linux or WSL2:
#
#   curl -fsSL https://raw.githubusercontent.com/Bruce-Hopkins/leafi/main/install.sh | sh
#
# It downloads the MCP server, a single file, to ~/.leafi, then
# runs its setup. The setup shows a checklist of the agents it finds (Hermes,
# Claude Code, Claude Desktop, Cursor) and installs only into the ones you
# tick, then asks for a provider API key and which permissions flows may use.
# Without a terminal it installs into nothing. Running it again updates the
# server and repeats the setup.
#
# The server file also runs the flow commands (validate, graph, run, ...), so
# the script links the leafi command to it, in ~/.local/bin or
# LEAFI_BIN_DIR. If that folder is not on your PATH, it prints the
# line that adds it.
#
# To install a fork or a local build instead:
#   LEAFI_SERVER_URL     where the server file is downloaded from
#   LEAFI_PLUGIN_SOURCE  what `hermes plugins install` is given
set -eu

repo=Bruce-Hopkins/leafi
server_url=${LEAFI_SERVER_URL:-https://raw.githubusercontent.com/$repo/main/hermes-plugin/dist/server.mjs}
bin_dir=${LEAFI_BIN_DIR:-$HOME/.local/bin}
command_path=$bin_dir/leafi

say() { printf '%s\n' "$*" >&2; }
fail() { say "Error: $*"; exit 1; }

# Piped into sh, this script's input is the script itself, so the setup reads
# the terminal instead. With no terminal, nothing asks.
interactive() { [ -t 2 ] && (: </dev/tty) 2>/dev/null; }

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    fail "curl or wget is needed to download $1"
  fi
}

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required: https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] 2>/dev/null || fail "Node.js 22 or newer is required; this machine has $(node -v)."

# leafi was called agents-automations before 0.0.3. A home folder set under the
# old name is still used, and the old default folder is moved, settings, saved
# flows and runs included, so an update keeps them.
dir=${LEAFI_HOME:-${AGENTS_AUTOMATIONS_HOME:-$HOME/.leafi}}
legacy_dir=$HOME/.agents-automations
if [ -z "${LEAFI_HOME:-}${AGENTS_AUTOMATIONS_HOME:-}" ] && [ ! -e "$dir" ] && [ -d "$legacy_dir" ]; then
  mv "$legacy_dir" "$dir"
  say "Moved $legacy_dir to $dir (agents-automations is now called leafi)."
fi
server=$dir/server.mjs
mkdir -p "$dir"
chmod 700 "$dir"
say "Downloading the server to $server ..."
download "$server_url" "$server.part" || fail "Could not download $server_url"
chmod 755 "$server.part"
mv "$server.part" "$server"

# A link rather than a copy, so updating the server updates the command. A
# folder that cannot be written is not fatal: node "$server" still works.
linked=no
if mkdir -p "$bin_dir" 2>/dev/null && ln -sf "$server" "$command_path" 2>/dev/null; then
  linked=yes
  say "Linked the leafi command: $command_path"
  # The command from before the rename pointed into the old folder; it now
  # runs the same server, so scripts that use it keep working.
  if [ -L "$bin_dir/agents-automations" ] && ln -sf "$server" "$bin_dir/agents-automations" 2>/dev/null; then
    say "The old agents-automations command still works and runs leafi."
  fi
else
  say "Could not create $command_path; run the commands as node \"$server\" <command> instead."
fi

status=0
if interactive; then
  say ""
  node "$server" init </dev/tty || status=$?
else
  say ""
  say "There is no terminal to ask where to install it, so nothing was installed into an agent."
  say "Finish the setup in a terminal:"
  say "  node \"$server\" init"
fi

if [ "$linked" = yes ]; then
  case ":$PATH:" in
    *":$bin_dir:"*)
      found=$(command -v leafi 2>/dev/null || true)
      if [ -n "$found" ] && [ "$found" != "$command_path" ]; then
        say ""
        say "Note: $found comes first on your PATH, so leafi runs that one, not $command_path."
      fi
      ;;
    *)
      say ""
      say "$bin_dir is not on your PATH. To type leafi, add this line to"
      say "your shell's profile (~/.zshrc, ~/.bashrc or ~/.profile) and open a new terminal:"
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac
fi
exit "$status"
