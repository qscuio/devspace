# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## `devspace` Command Not Found

Use `npx`:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

DevSpace requires Node `>=20.12 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
npx @waishnav/devspace doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
npx @waishnav/devspace config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

For a one-off run:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable URL:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Host Header Or 403 Problems

DevSpace derives allowed hosts from the configured public URL.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

Use this only for intentional local debugging:

```bash
DEVSPACE_ALLOWED_HOSTS="*" npx @waishnav/devspace serve
```

## OAuth Redirect Host Rejected

By default, DevSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, configure:

```bash
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" npx @waishnav/devspace serve
```

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.devspace/auth.json
```

To regenerate setup:

```bash
npx @waishnav/devspace init --force
```

## Unknown `workspaceId`

`workspaceId` values are session identifiers. If the server restarts and the
client receives an unknown workspace error, call `open_workspace` again for that
project.

Workspace session metadata is persisted, but clients should still treat
`open_workspace` as the way to begin a fresh working session.

## Workspace Path Rejected

The path must be inside one of the allowed roots configured during setup.

Run:

```bash
npx @waishnav/devspace config get
```

Then either open a project under an allowed root or rerun setup:

```bash
npx @waishnav/devspace init --force
```

## Worktree Mode Fails

Worktree mode requires:

- Git installed
- the path is inside a Git repository
- the repository has at least one commit
- the requested `baseRef` resolves to a commit

For a new repository, create the first commit or use checkout mode.

Uncommitted source checkout changes are not copied into the managed worktree.
Commit, stash, or ask the model to work in checkout mode if those changes are
needed.

## Windows Shell Commands Fail

DevSpace shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not supported yet.

Install Git for Windows and use Git Bash, or use WSL, MSYS2, or Cygwin Bash.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm Bash is detected.

## Skills Do Not Appear

Skills are enabled by default. Check:

```bash
DEVSPACE_SKILLS=1 npx @waishnav/devspace serve
```

DevSpace looks in:

- `DEVSPACE_AGENT_DIR`, defaulting to `~/.codex`
- project `.pi/skills`
- `DEVSPACE_SKILL_PATHS`

If a skill appears in `open_workspace`, the model must read that skill's
`SKILL.md` before reading other files inside the skill directory.

## NotebookLM Keeps Asking For Google Login

NotebookLM uses upstream browser automation. Keep the NotebookLM data directory
stable so the browser profile can be reused:

```bash
DEVSPACE_NOTEBOOKLM_DATA_DIR="$HOME/.local/share/devspace/notebooklm" \
npx @waishnav/devspace serve
```

Run `notebooklm_status` and follow its repair hint. If the profile is stale,
rerun auth with a visible browser on the host running DevSpace. If another
Chrome or Chromium process is using the same profile, close it before retrying.

## NotebookLM Sessions Expire

DevSpace stores reusable NotebookLM session references and refreshes them after
successful follow-up questions. The default reuse window is 900 seconds:

```bash
DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS=900 npx @waishnav/devspace serve
```

Use `fresh_session: true` with `notebooklm_research` when you intentionally want
to start over. Use `notebooklm_library` with `action: "clear_sessions"` to clear
stored sessions for a notebook.

## NotebookLM Discovery Misses Notebooks

`notebooklm_discover` is best-effort because NotebookLM does not expose a stable
public notebook-list API. Discovery imports visible notebook cards when the
signed-in browser profile can see them, but it may miss notebooks after UI
changes, account switches, or browser failures.

Use the exact NotebookLM URL with `notebooklm_research` when discovery misses a
notebook. DevSpace will add minimal local metadata for that URL so future
queries can resolve it.

## Review Card Does Not Appear

The aggregate review widget is enabled by default with:

```bash
DEVSPACE_WIDGETS=changes
```

Use `DEVSPACE_WIDGETS=full` to attach widget UI to every exposed coding tool.
Plain MCP clients may ignore ChatGPT Apps widget metadata and only show text
results.
