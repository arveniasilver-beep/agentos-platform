# Connectors v2 — Framework & MCP Plan (TICKET-9)

Flag-gated by `CONNECTORS_V2_ENABLED` (default false). Builds the connector **framework** on top of the
existing OAuth + envelope-encrypted secret layer (which already covers GitHub/Notion/Google/Outlook with
signed-state OAuth, per-row AES-256-GCM secrets, and RLS). Flag-off keeps the existing connectors
byte-identical.

## What this ticket adds
- **Manifest registry** (`connector-registry.ts`): each connector declares `{ provider, version,
  capabilities[], actions[{id, requiredScopes[]}], triggers[{id, webhook}] }`. Built-ins have a static
  registry; `validateManifest` rejects malformed/duplicate-id manifests, so an invalid manifest never
  registers.
- **Capability-scope enforcement** (`actionAllowed` / `ConnectorRegistryService.checkAction`): a connector
  action runs only if the connection actually granted the action's `requiredScopes`. The task-runner
  connector sink calls `checkAction` for every connector tool call (flag-gated) and audits any
  `connector.action_denied`. (Live tool-provisioning gating — only advertising in-scope actions to the
  model — is the documented next step on top of this primitive.)
- **Secure webhook ingestion** (`ingestWebhook` + `ConnectorWebhookController`): a per-connection secret
  (only its sha256 hash stored), constant-time compared, **uniform 404** on any failure (no enumeration
  oracle), per-IP throttled like every other public entry point. Events are stored **redacted + minimal**
  (`ConnectorEvent`: event type + short summary) — never the raw payload or secrets.
- **Health** (`health`): per-connection connected + webhook-configured + action count + last-event time.

## Security boundaries (unchanged + reaffirmed)
Secrets never leave the server in clear and never reach logs/audit (existing CryptoService envelope
encryption; webhook events are `redactText`-redacted). `Connection` + `Secret` + `ConnectorEvent` are
RLS workspace-isolated. Webhook auth is the per-connection secret; cross-workspace access is impossible
(the workspace is resolved server-side from the connection id). Connector actions are subject to the
existing policy engine, plus this scope check.

## MCP compatibility plan
The manifest shape is deliberately **MCP-tool-compatible**, so the same registry can back a future MCP
(Model Context Protocol) server without redesign:

| Connector manifest | MCP concept |
|---|---|
| `action.id` | MCP tool `name` |
| `action.description` | MCP tool `description` |
| `action.requiredScopes` | MCP tool capability scopes / permission gating |
| `trigger` (webhook) | MCP server notification / resource subscription |
| `capabilities[]` | MCP server `capabilities` |

A future MCP server/client (out of scope here) would: expose each in-scope connector action as an MCP
tool, enforce `requiredScopes` as the capability gate, and map inbound webhook events to MCP
notifications. No model/manifest change is required — only the MCP transport adapter.

## Built-in connector review (minimal)
GitHub (`repo` scope; list_repos/get_file/search_code + `github:push` webhook trigger), Notion (no scope;
search/get_page), Google (calendar/drive/gmail read scopes), Outlook (Mail.Read/Calendars.Read). All are
read-only today; write actions would each declare their own `requiredScopes`.

## Out of scope (future)
Authoring thousands of integrations, a public connector marketplace, a paid connector store, the MCP
transport implementation, and live tool-provisioning scope-gating (the `checkAction` primitive is ready).
