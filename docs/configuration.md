# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Cloudflare Access

For public Cloudflare Tunnel deployments, put a Cloudflare Access self-hosted
application in front of the public hostname and configure DevSpace to verify
the Access JWT that Cloudflare forwards to the origin.

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_CLOUDFLARE_ACCESS` | Set to `1` to require Cloudflare Access JWT verification. |
| `DEVSPACE_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Your Access team domain, for example `team.cloudflareaccess.com`. |
| `DEVSPACE_CLOUDFLARE_ACCESS_AUD` | Comma-separated Access application audience tags. |
| `DEVSPACE_CLOUDFLARE_ACCESS_ALLOWED_EMAILS` | Optional comma-separated emails allowed by DevSpace after Access succeeds. |

The equivalent persisted config shape is:

```json
{
  "cloudflareAccess": {
    "enabled": true,
    "teamDomain": "team.cloudflareaccess.com",
    "audience": ["your-application-aud"],
    "allowedEmails": ["you@example.com"]
  }
}
```

Cloudflare Access should still be configured in the Cloudflare Zero Trust
dashboard. DevSpace verification is a defense-in-depth check for requests that
reach the origin.

## Tool Modes

`DEVSPACE_TOOL_NAMING` controls tool names.

| Value | Behavior |
| --- | --- |
| `short` | Default. Uses `read`, `edit`, `bash`, and related names. |
| `legacy` | Uses `read_file`, `edit_file`, `run_shell`, and related names. |

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Disables dedicated search and list tools. Clients use the shell tool with `rg`, `grep`, `find`, `ls`, or `tree` for inspection. |
| `full` | Enables dedicated `grep`, `glob`, and `ls` tools. |

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated skill directories. |

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.codex/skills,$HOME/.claude/skills" \
npx @waishnav/devspace serve
```

## NotebookLM

DevSpace exposes high-level NotebookLM tools by default with a `notebooklm_`
prefix. The bridge starts the upstream `notebooklm-mcp` stdio server lazily,
only when a NotebookLM tool is called. If that upstream browser automation is
unstable in your environment, disable only the NotebookLM bridge:

```bash
DEVSPACE_NOTEBOOKLM=0 npx @waishnav/devspace serve
```

| Variable | Default |
| --- | --- |
| `DEVSPACE_NOTEBOOKLM` | `1` |
| `DEVSPACE_NOTEBOOKLM_COMMAND` | `npx` |
| `DEVSPACE_NOTEBOOKLM_ARGS` | `-y,-p,notebooklm-mcp@1.2.1,-p,@modelcontextprotocol/sdk@1.28.0,notebooklm-mcp` |
| `DEVSPACE_NOTEBOOKLM_RAW_TOOLS` | `0` |
| `DEVSPACE_NOTEBOOKLM_DATA_DIR` | `<DEVSPACE_STATE_DIR>/notebooklm` |
| `DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS` | `900` |

The default tools are:

- `notebooklm_status` for auth, profile, library, session, and repair status.
- `notebooklm_discover` for best-effort discovery of notebooks visible to the
  signed-in NotebookLM browser profile.
- `notebooklm_library` for listing/searching local NotebookLM metadata and
  clearing stored sessions.
- `notebooklm_research` for asking a selected notebook by URL, ID, alias, or
  search term.

Set `DEVSPACE_NOTEBOOKLM_RAW_TOOLS=1` only when you need the upstream
`notebooklm-mcp` tools directly for debugging. Raw tools include
`notebooklm_get_health`, `notebooklm_setup_auth`, `notebooklm_list_notebooks`,
`notebooklm_add_notebook`, and `notebooklm_ask_question`.

`DEVSPACE_NOTEBOOKLM_DATA_DIR` stores the local library, session registry, and
upstream browser/profile state. Keep it stable across restarts to avoid repeated
Google authentication. `DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS` controls how
long a NotebookLM session can be reused; active successful follow-ups refresh
the session record.

Discovery is best-effort because NotebookLM does not provide a stable public
notebook-list API. If discovery misses a notebook, pass its NotebookLM URL
directly to `notebooklm_research`.

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_TOOL_NAMING="short" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
