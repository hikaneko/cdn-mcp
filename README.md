# Akamai CDN MCP

An MCP server, built on [Zuplo](https://zuplo.com), that exposes two Akamai CDN APIs as tools for MCP clients such as Claude Desktop: **Fast Purge (CCU v3)** for cache purging by URL, and **Property Manager (PAPI v1)** for read-only viewing of property configs, rule trees, and activation status.

Unlike a passthrough-token gateway, this project **holds Akamai EdgeGrid credentials server-side** and computes a fresh HMAC-SHA256 signature for every request. MCP clients supply no credentials of their own — anyone who can reach this gateway's `/mcp` endpoint can purge cache and read property configs on the configured account, so treat the deployed URL itself as sensitive.

## Tools exposed

| Tool | Akamai API operation | Effect |
| --- | --- | --- |
| `delete-by-url` | CCU v3 `POST /delete/url/{network}` | **Destructive/write.** Immediately removes URLs from cache. |
| `invalidate-by-url` | CCU v3 `POST /invalidate/url/{network}` | **Destructive/write.** Marks URLs stale (revalidated on next request). |
| `check-purge-rate-limit-status` | CCU v3 `POST /rate-limit-status/{purge-type}` | Read-only. Account-wide rate-limit tokens remaining for a purge object type — **not** a lookup by purge ID (no such endpoint exists in CCU v3). |
| `get-contracts` | PAPI v1 `GET /contracts` | Read-only. |
| `get-groups` | PAPI v1 `GET /groups` | Read-only. |
| `get-properties` | PAPI v1 `GET /properties` | Read-only. |
| `get-property` | PAPI v1 `GET /properties/{propertyId}` | Read-only. |
| `get-property-versions` | PAPI v1 `GET /properties/{propertyId}/versions` | Read-only. |
| `get-property-version-rules` | PAPI v1 `GET /properties/{propertyId}/versions/{propertyVersion}/rules` | Read-only. |
| `get-property-activations` | PAPI v1 `GET /properties/{propertyId}/activations` | Read-only. |
| `get-property-activation` | PAPI v1 `GET /properties/{propertyId}/activations/{activationId}` | Read-only. |

No Property Manager write/activation endpoints are exposed by design.

## Project structure

| Path | Role |
| --- | --- |
| `config/routes.oas.json` | Single source of truth for routing — an OpenAPI document where every path/operation is a route with an `x-zuplo-route` extension. Both the CCU/PAPI proxy routes and the `/mcp` MCP-server route are defined here. |
| `config/policies.json` | Named policy instances routes reference by name. Registers the EdgeGrid signing policy twice, once per upstream API (`edgegrid-signing-ccu-inbound`, `edgegrid-signing-papi-inbound`), since each needs a different `apiPathPrefix`. |
| `modules/edgegrid-signing-inbound.ts` | Computes the Akamai EdgeGrid `EG1-HMAC-SHA256` signature for every request and injects it as the `Authorization` header, before `urlForwardHandler` forwards to Akamai. Uses the Web Crypto API (`crypto.subtle`), not the Node-`crypto`-based official `akamai-edgegrid` package, for edge-runtime compatibility. |

## Deploy your own copy

This repo is meant to be forked and deployed to your own Zuplo account — your Akamai EdgeGrid credentials live in whichever Zuplo project runs this gateway, so it should be one you control.

1. Fork this repository.
2. In the [Zuplo portal](https://portal.zuplo.com), create a new project and connect it to your fork.
3. Under **Settings > Environment Variables**, set these as **secrets**, for whichever environment you're deploying (Working Copy / Preview / Production don't share values):
   - `EDGERC_CLIENT_TOKEN`
   - `EDGERC_CLIENT_SECRET`
   - `EDGERC_ACCESS_TOKEN`
   - `EDGERC_HOST` (bare hostname, no scheme)
4. Deploy the environment from the portal, and **redeploy any time you change an env var** — changes don't take effect until redeployed. Note the deployed URL; your MCP endpoint is `https://<your-project>.zuplo.app/mcp`.

## Connect from Claude Desktop

Since auth is server-side, no per-client header is needed:

```json
{
  "mcpServers": {
    "akamai-cdn": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-project>.zuplo.app/mcp"]
    }
  }
}
```

Restart Claude Desktop after editing `claude_desktop_config.json`.

## Local development

```bash
npm install
npm run dev
```

Starts the gateway at `http://localhost:9000` (route designer at `:9100`). Requires Node.js >= 24 for the Zuplo CLI.

Before testing through `/mcp`, smoke-test signing directly against a CCU or PAPI route (e.g. `curl -X POST localhost:9000/invalidate/url/staging -d '{"objects":["https://example.com/test"]}'`) with real credentials in a local `.env`, to isolate signing bugs from MCP-protocol issues. Then verify the full `tools/call` path via `mcp-remote` or Claude Desktop before trusting a deploy — a signing bug that passes direct-route tests can still surface only when called through the actual MCP client.

Always test `network=staging` and `invalidate-by-url` before ever exercising `network=production` or `delete-by-url`.

## Extending

All routing lives in `config/routes.oas.json`. To expose another CCU or PAPI operation as an MCP tool:

1. Add it as a new OpenAPI path/operation with a unique `operationId`, an `x-zuplo-route.handler` of `urlForwardHandler` pointed at the matching `baseUrl` (`https://${env.EDGERC_HOST}/ccu/v3` or `.../papi/v1` — note the `${env.VAR}` syntax, not `$env(VAR)`, is required specifically inside `baseUrl`), the matching `edgegrid-signing-{ccu,papi}-inbound` policy, and `x-zuplo-route.mcp.type: "tool"`.
2. Add a matching `{ "file": "./config/routes.oas.json", "id": "<operationId>" }` entry to the `/mcp` route's `mcpServerHandler` `operations` array.

See Akamai's [CCU v3](https://techdocs.akamai.com/purge-cache/reference/api) and [PAPI v1](https://techdocs.akamai.com/property-mgr/reference/api-summary) API references for other available operations.

## Guardrails

- **`/mcp` is restricted by source IP.** The `ip-address-restriction-inbound` policy (added via the Zuplo portal) allows only `ALLOWED_IP_1`/`ALLOWED_IP_2` to reach `/mcp` — set these as env vars for the environment the same way as the `EDGERC_*` secrets. Requests from any other IP are rejected before reaching the EdgeGrid signing policy.
- **No confirm-before-purge policy.** Tool descriptions ask the calling model to confirm destructive purges with the user, but nothing server-side enforces it. A sibling project's equivalent guardrail passed every direct/local test but broke unexplainably through Claude Desktop, so this is deferred until EdgeGrid signing itself has been verified stable end-to-end in production.
