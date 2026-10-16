# Connectors (Beta)

Connectors let agents in Synara use remote MCP servers such as Supabase, Linear, or Notion.
The user signs in once in **Settings → Connectors**, and new chats get the server's tools.
Connectors are Beta-only (`MCP_CONNECTORS_BETA_FEATURE`): Stable refuses the RPCs, the OAuth
callback, and the proxy routes, and never reads saved connectors.

This is the opposite direction of [External MCP](./external-mcp.md), which lets outside agents
call into Synara.

## How it works

| Step     | What happens                                                                                                                                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect  | The server sends an unauthenticated MCP `initialize` to the connector URL. A valid JSON-RPC initialize result means no sign-in is needed. Existing OAuth connections retain their credentials if initialization is public. A 401 starts OAuth.                                                           |
| Sign-in  | The MCP SDK's OAuth client discovers the protected-resource and authorization-server metadata, registers Synara with Dynamic Client Registration, and builds a PKCE (S256) authorization URL with a single-use `state` and the RFC 8707 `resource`. The web app opens it in the default browser.         |
| Callback | The browser returns to `GET /oauth/mcp/callback` on Synara's loopback port. The `state` is the only authority (the browser carries no Synara session); it expires after ten minutes. The code is exchanged for tokens.                                                                                   |
| Storage  | All connectors and their tokens are one entry (`mcp-connectors`) in the server secret store: a `0600` file under the Synara home. Tokens never reach the web app or provider processes.                                                                                                                  |
| Sessions | Connected connectors are published to the agent gateway. Each new provider session gets one MCP server per connector, named `<slug>_connector`, pointing at `/mcp/connectors/<id>` on the gateway and authenticated with the session's gateway bearer.                                                   |
| Calls    | The proxy checks the bearer, attaches the connector's access token, and forwards the exchange through the origin-pinned outbound client. SSE answers are collapsed to their JSON-RPC response. A 401 triggers one refresh and one retry; a rejected refresh grant marks the connector **needs sign-in**. |

The `_connector` suffix reduces accidental overlap with user-configured MCP servers. Codex
deep-merges same-named tables, so Synara reads its effective configuration and omits a connector
whose name is already present rather than altering the user's server. If that configuration
cannot be checked, connectors are omitted for that session. Names never start with `synara`,
which tool policy treats as trusted.

## Provider coverage

| Provider                      | Connectors                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Claude                        | Yes, as SDK `mcpServers` HTTP entries                                                        |
| Codex                         | Yes, in the per-thread config only (re-sent on every credential renewal)                     |
| OpenCode                      | Yes, through `mcp.add` on the managed server; a connector that fails to start is skipped     |
| Cursor, Grok, Droid, Oh My Pi | Only when the agent advertises ACP HTTP MCP support; the stdio proxy carries no MCP sessions |
| Pi, Devin, Antigravity        | No                                                                                           |

Running sessions keep the connector set they started with. A disconnected connector answers its
remaining calls with a JSON-RPC error.

Third-party tool calls follow each provider's normal approval flow. Codex still cancels MCP
elicitation requests other than tool approvals.

## Catalog

The presets live in `packages/shared/src/mcpConnectors.ts`. Each one was checked against the live
server: it either answers anonymously (Hugging Face) or accepts dynamic registration from an
unknown client. Vercel documents that it admits only clients it has reviewed, yet a full sign-in
from Synara succeeded on 2026-10-14; its consent page names Synara "An MCP client" until Vercel
approves it through its [client review form](https://forms.gle/FQ3nYPbovoHvbfmz9). Todoist
(`ai.todoist.net/mcp`) accepted a test registration from Synara on 2026-10-14. Slack registers no
clients, so its preset asks for the user's own Slack app (client ID and secret) and shows the
redirect URL to paste into it. Vendors that refuse registration (Figma) or require a
pre-registered OAuth app (GitHub, Asana, HubSpot) are left out; their custom URLs fail with an
explanation instead.

Each preset sits on one shelf (`category`: Popular, Developer tools, or Productivity), which is
how Settings → Connectors groups the catalog under its search field.

Convex's hosted server (`mcp.convex.dev`) only guides setup and scaling; its deployment tools run
in the local `npx convex mcp start` server, which connectors cannot reach. WorkOS has no Simple
Icons mark, so its icon is the site favicon.

Custom URLs must be public `https://` endpoints without credentials.

## Limits

- Connecting needs a loopback-only instance, because the OAuth redirect targets this machine's
  loopback port. The desktop picks a new port per launch, so every sign-in registers a fresh
  client.
- A user's own OAuth app (Slack) accepts only the redirect URL registered with it, and that URL
  carries the current port. After the desktop restarts, reconnecting fails until the app's
  redirect URL is updated to the one the connect dialog shows.
- The MCP 2026-07-28 revision prefers Client ID Metadata Documents over Dynamic Client
  Registration. Supporting it needs a hosted client metadata document on a Synara domain.
- Disconnecting invalidates pending sign-ins, deletes the tokens locally and attempts RFC 7009 revocation when the server
  advertises a revocation endpoint.
