# Installs leafi on Windows. In PowerShell:
#
#   irm https://raw.githubusercontent.com/Bruce-Hopkins/leafi/main/install.ps1 | iex
#
# It downloads the MCP server, a single file, to ~\.leafi, then
# runs its setup. The setup shows a checklist of the agents it finds (Hermes,
# Claude Code, Claude Desktop, Cursor) and installs only into the ones you
# tick, then asks for a provider API key and which permissions flows may use.
# Running it again updates the server and repeats the setup.
#
# The server file also runs the flow commands (validate, graph, run, ...), so
# the script adds a leafi command: leafi.cmd in
# ~\.leafi\bin, a folder it puts on your user PATH.
#
# To install a fork or a local build instead:
#   $env:LEAFI_SERVER_URL     where the server file is downloaded from
#   $env:LEAFI_PLUGIN_SOURCE  what `hermes plugins install` is given

# Run inside a script block, so an error stops the install without closing the
# PowerShell window that `iex` runs in.
& {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'Bruce-Hopkins/leafi'
  $serverUrl = if ($env:LEAFI_SERVER_URL) { $env:LEAFI_SERVER_URL } else { "https://raw.githubusercontent.com/$repo/main/hermes-plugin/dist/server.mjs" }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or newer is required: https://nodejs.org' }
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -lt 22) { throw "Node.js 22 or newer is required; this machine has $(node -v)." }

  # leafi was called agents-automations before 0.0.3. A home folder set under the
  # old name is still used, and the old default folder is moved, settings, saved
  # flows and runs included, so an update keeps them. Its bin folder, with the
  # old command in it, moves along and stays on the PATH through the new one.
  $dir = if ($env:LEAFI_HOME) { $env:LEAFI_HOME } elseif ($env:AGENTS_AUTOMATIONS_HOME) { $env:AGENTS_AUTOMATIONS_HOME } else { Join-Path $HOME '.leafi' }
  $legacyDir = Join-Path $HOME '.agents-automations'
  if (-not $env:LEAFI_HOME -and -not $env:AGENTS_AUTOMATIONS_HOME -and -not (Test-Path $dir) -and (Test-Path $legacyDir -PathType Container)) {
    Move-Item $legacyDir $dir
    Write-Host "Moved $legacyDir to $dir (agents-automations is now called leafi)."
  }
  $server = Join-Path $dir 'server.mjs'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Host "Downloading the server to $server ..."
  Invoke-WebRequest -Uri $serverUrl -OutFile "$server.part" -UseBasicParsing
  Move-Item -Force "$server.part" $server

  # %~dp0 is the folder the .cmd is in, so the command finds the server beside
  # it without a path written into the file, and updating the server updates it.
  $bin = Join-Path $dir 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $command = Join-Path $bin 'leafi.cmd'
  Set-Content -Path $command -Value '@node "%~dp0..\server.mjs" %*' -Encoding Ascii
  Write-Host "Created the leafi command: $command"

  # The registry value is read and written raw, so entries such as
  # %USERPROFILE%\bin stay unexpanded. Setting and clearing a variable through
  # .NET then tells Windows the environment changed, so new terminals see it.
  $environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $userPath = [string]$environment.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $legacyBin = Join-Path $legacyDir 'bin'
  if (($userPath -split ';') -contains $legacyBin) {
    $userPath = (($userPath -split ';') | Where-Object { $_ -and $_ -ne $legacyBin }) -join ';'
    $environment.SetValue('Path', $userPath, 'ExpandString')
  }
  if (-not (($userPath -split ';') -contains $bin)) {
    $environment.SetValue('Path', ((@($userPath.TrimEnd(';'), $bin) | Where-Object { $_ }) -join ';'), 'ExpandString')
    [Environment]::SetEnvironmentVariable('LEAFI_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('LEAFI_PATH_REFRESH', $null, 'User')
    Write-Host "Added $bin to your user PATH. Terminals that were already open need restarting to see it."
  }
  $environment.Close()
  if (-not (($env:Path -split ';') -contains $bin)) { $env:Path = "$env:Path;$bin" }

  # Without a console, init installs into nothing and prints how to finish.
  Write-Host ''
  node $server init
}
