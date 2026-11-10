# Install Cat Burglar in your agent

Cat Burglar is a stdio MCP server. Any MCP client that can launch a local command can use it.

## Before you start

- Node.js 22 or newer.
- Chromium, Chrome, or Chromium installed. `cat-burglar doctor` checks it.
- Optional: Obscura for the 43 MB engine. Run `pnpm run install:obscura` inside a clone, or download the binary and set `BROWSER_MCP_OBSCURA_PATH`.

## Install

One line:

```bash
curl -fsSL https://raw.githubusercontent.com/DrMkdaddy/cat-burglar/main/scripts/install.sh | bash
```

The installer uses pnpm when available, then npm. It installs the npm package when it exists and the latest release tarball otherwise.

Manual install with pnpm:

```bash
pnpm add -g https://github.com/DrMkdaddy/cat-burglar/releases/download/v0.3.3/cat-burglar-mcp-0.3.3.tgz
cat-burglar doctor
```

After the npm release:

```bash
pnpm dlx cat-burglar-mcp --version
pnpm add -g cat-burglar-mcp
```

## Pick your client

| Client | Where the config lives | Snippet |
| --- | --- | --- |
| Claude Code | CLI | `claude mcp add catburglar -- cat-burglar` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` JSON |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` JSON |
| Codex | `~/.codex/config.toml` | `mcp_servers` TOML |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` JSON |
| VS Code | `.vscode/mcp.json` | `servers` JSON |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` JSON |
| Cline | `cline_mcp_settings.json` | `mcpServers` JSON |
| OpenCode | `~/.config/opencode/opencode.jsonc` | `mcp.servers` JSON |
| Any other stdio client | command + args | `cat-burglar` |

Print the exact snippet for a client:

```bash
cat-burglar install --client claude-desktop
cat-burglar install --client cursor --slim
cat-burglar install --client opencode
```

## Standard JSON clients

Claude Desktop, Cursor, Windsurf, Cline, and Gemini CLI use this shape:

```json
{
  "mcpServers": {
    "catburglar": {
      "command": "cat-burglar"
    }
  }
}
```

Add environment variables inside the server object:

```json
{
  "mcpServers": {
    "catburglar": {
      "command": "cat-burglar",
      "env": {
        "BROWSER_MCP_ALLOW_PRIVATE_NETWORK": "1",
        "BROWSER_MCP_PROFILE": "flash"
      }
    }
  }
}
```

## Claude Code

```bash
claude mcp add catburglar -- cat-burglar
```

With private-network access and the slim toolset:

```bash
claude mcp add catburglar \
  --env BROWSER_MCP_ALLOW_PRIVATE_NETWORK=1 \
  -- cat-burglar --slim
```

## Codex

```toml
[mcp_servers.catburglar]
command = "cat-burglar"

[mcp_servers.catburglar.env]
BROWSER_MCP_ALLOW_PRIVATE_NETWORK = "1"
```

Or use the CLI:

```bash
codex mcp add catburglar -- cat-burglar
```

## VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "catburglar": {
      "type": "stdio",
      "command": "cat-burglar"
    }
  }
}
```

## OpenCode

```jsonc
{
  "mcp": {
    "servers": {
      "catburglar": {
        "type": "local",
        "command": ["cat-burglar"],
        "environment": {
          "BROWSER_MCP_ALLOW_PRIVATE_NETWORK": "1"
        },
        "timeout": { "startup": 45000, "execution": 600000 }
      }
    }
  }
}
```

Do not name the server `browser`. OpenCode has a built-in browser toolset with that name, and Code Mode will hide the overlapping tools.

## Docker

```bash
docker run -i --rm \
  -e BROWSER_MCP_ALLOW_PRIVATE_NETWORK=1 \
  ghcr.io/drmkdaddy/cat-burglar:latest
```

Build locally:

```bash
docker build -t cat-burglar .
docker run -i --rm \
  -e BROWSER_MCP_ALLOW_PRIVATE_NETWORK=1 \
  cat-burglar
```

For a client, use `docker` as the command:

```json
{
  "mcpServers": {
    "catburglar": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "cat-burglar"]
    }
  }
}
```

The image carries Chromium. Add `--slim` after `cat-burglar` in the args if your client pays for every schema.

## Slim mode

`--slim` exposes 14 tools instead of 30:

`open`, `close`, `navigate`, `status`, `snapshot`, `markdown`, `extract`, `evaluate`, `screenshot`, `click`, `fill`, `press`, `select`, `wait`.

Use it in clients that load every tool schema into context. The full set adds tabs, storage, cookies, network, console, perf, stealth, memory, PDF, scrolling, hover, and upload.

```bash
cat-burglar --slim
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROWSER_MCP_ENGINE` | `patchright` | `patchright`, `chromium`, or `obscura` |
| `BROWSER_MCP_PROFILE` | `flash` | `local`, `flash`, `frontier`, or `auto` |
| `BROWSER_MCP_ALLOW_PRIVATE_NETWORK` | `false` | Allow localhost and LAN |
| `BROWSER_MCP_OBSCURA_PATH` | auto | Path to the Obscura binary |
| `BROWSER_MCP_CHROMIUM_PATH` | auto | Path to Chromium or Chrome |
| `BROWSER_MCP_TOOLSET` | `full` | Set to `slim` for 14 tools |
| `BROWSER_MCP_RISKY_ACTION_POLICY` | `warn` | `off`, `warn`, or `ask` |
| `BROWSER_MCP_MEMORY_PATH` | `~/.cache/browser-mcp/site-memory.json` | Site memory store |
| `BROWSER_MCP_DEBUG` | off | Diagnostics on stderr |

## Check the install

```bash
cat-burglar doctor
```

Expected output:

```text
Cat Burglar 0.3.3
ok    node         v22.x
ok    package      /path/to/package.json
ok    chromium     /usr/bin/chromium
warn  obscura      not installed; run pnpm run install:obscura
ok    config       /home/you/.config/browser-mcp/config.json
ok    memory       /home/you/.cache/browser-mcp/site-memory.json
ok    profile      flash (2800 snapshot chars)
ok    network      private network blocked
```

Obscura is optional. The default engine is Patchright over Chromium.

## Troubleshooting

**The client cannot find cat-burglar.** Run `pnpm setup`, restart your shell, or add `$(pnpm bin -g)` to PATH. On Windows, use `cmd` with args `["/c", "cat-burglar"]`.

**The browser does not launch.** Run `cat-burglar doctor` and set `BROWSER_MCP_CHROMIUM_PATH` to a Chromium or Chrome binary.

**Private pages are blocked.** Set `BROWSER_MCP_ALLOW_PRIVATE_NETWORK=1` or pass `allow_private: true` to `open` or `navigate`. Cloud metadata endpoints stay blocked.

**Your client shows only 14 tools.** You launched with `--slim`. Remove the flag or set `BROWSER_MCP_TOOLSET=full`.

**The tools appear under a different name.** OpenCode names tools `<server>_<tool>` and Code Mode groups them under the server key. This package uses `catburglar`.
