# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Cloudflare Access

For Cloudflare Tunnel deployments, create a Cloudflare Access self-hosted
application for your DevSpace hostname before exposing the route publicly.
Cloudflare Access is deny-by-default, so users must match an Allow policy before
Cloudflare forwards traffic to DevSpace.

DevSpace can also verify the Cloudflare Access JWT at the origin:

```bash
DEVSPACE_CLOUDFLARE_ACCESS=1 \
DEVSPACE_CLOUDFLARE_ACCESS_TEAM_DOMAIN="team.cloudflareaccess.com" \
DEVSPACE_CLOUDFLARE_ACCESS_AUD="your-application-aud" \
npx @waishnav/devspace serve
```

Add `DEVSPACE_CLOUDFLARE_ACCESS_ALLOWED_EMAILS` if you want DevSpace to enforce
specific user emails in addition to the Cloudflare policy.

This does not replace DevSpace OAuth. Use both layers: Cloudflare Access decides
who can reach the public hostname, and the DevSpace Owner password approves the
MCP client session.

## NotebookLM

NotebookLM tools are enabled by default and run through the upstream
`notebooklm-mcp` browser automation package. That package stores Google browser
state on the host running DevSpace, so treat a VPS deployment as holding a
logged-in browser profile. Use a dedicated Google account when possible, protect
the public hostname with Cloudflare Access plus DevSpace OAuth, and set
`DEVSPACE_NOTEBOOKLM=0` if you do not want NotebookLM exposed from a deployment.

By default, DevSpace keeps NotebookLM library metadata, reusable session
references, and upstream profile data under `<DEVSPACE_STATE_DIR>/notebooklm`.
You can move that state with `DEVSPACE_NOTEBOOKLM_DATA_DIR`. Keep the directory
private to the server user and do not place it in a shared project checkout.

The default NotebookLM tools are the high-level `notebooklm_status`,
`notebooklm_discover`, `notebooklm_library`, and `notebooklm_research` tools.
They can write local metadata and session state even when the underlying
NotebookLM notebook is only being read. Raw upstream tools are hidden unless
`DEVSPACE_NOTEBOOKLM_RAW_TOOLS=1` is set for debugging.

If Google authentication becomes stale, use `notebooklm_status` to get the
repair hint. Session reuse is automatic, but stale browser profiles may still
need a visible browser login on the host running DevSpace.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.
