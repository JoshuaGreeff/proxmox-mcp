# Direct MCP Testing

This document describes the preferred maintainer workflow for querying and mutating the MCP server directly without relying on an editor-integrated MCP client.

The goal is to test the actual stdio MCP server process and its tool contracts, while avoiding false confidence caused by stale editor state, reload issues, or client-specific behavior.

## Why This Exists

When testing through an editor-integrated MCP client, there are two separate systems in play:

- the `proxmox-mcp` stdio server
- the editor or agent handler that launches and caches that server

If the editor-side MCP process is stale, you can end up testing old config or old code even when the repo is updated correctly.

Direct stdio testing removes that extra layer:

- it starts the server from this repo directly
- it uses the same MCP transport the real client uses
- it exercises the actual tool schema and responses
- it avoids editor reload ambiguity

This is the preferred path for live validation of new MCP tools and module behavior.

## Source Of Truth For The Harness

The direct test harness lives in [mcp-live-helpers.ts](../tests/live/mcp-live-helpers.ts).

Key behavior:

- supports the env-only runtime path
- for the steady-state path, expects:
  - `PROXMOX_HOST`
  - `PROXMOX_API_TOKEN_USER`
  - `PROXMOX_API_TOKEN_SECRET`
- starts the built server from `dist/index.js` when available
- otherwise falls back to the source entrypoint in [index.ts](../src/index.ts)
- talks to the server over stdio using the MCP SDK client

## Required Environment

At minimum:

- `PROXMOX_HOST`
- `PROXMOX_API_TOKEN_USER`
- `PROXMOX_API_TOKEN_SECRET`

Typical PowerShell setup:

```powershell
$env:PROXMOX_HOST = "proxmox.example.internal"
$env:PROXMOX_API_TOKEN_USER = "proxmox-mcp"
$env:PROXMOX_API_TOKEN_SECRET = "replace-me"
```

## Recommended Validation Sequence

Use this order when validating new tools or module changes:

1. `npm run check`
2. `npm run test`
3. `npm run build`
4. direct stdio smoke:
   - `listTools`
   - one or two read-only typed tools such as `proxmox_cluster_status` or `proxmox_inventory_overview`
5. direct stdio mutation testing for the specific module under development
6. follow-up read to confirm the resulting Proxmox-side state

Do not rely on editor reload behavior as the main proof that a module works.

## Example: Direct MCP Read

This pattern queries the live server directly from the repo without adding the MCP server to an external agent handler:

```powershell
@'
import { createLiveClient, callToolRecord } from "./tests/live/mcp-live-helpers.ts";

const client = await createLiveClient();
try {
  const data = await callToolRecord(client, "proxmox_vm_list", {
    cluster: "default",
  });
  console.log(JSON.stringify(data, null, 2));
} finally {
  await client.close();
}
'@ | npx tsx -
```

This tests:

- the actual stdio server startup
- real config loading
- steady-state secret-backed auth initialization
- real MCP tool registration
- the actual tool result shape returned by the server

## Example: Direct MCP Mutation

Mutation testing should use the same direct harness, not raw SSH:

```powershell
@'
import { createLiveClient, callToolRecord } from "./tests/live/mcp-live-helpers.ts";

const client = await createLiveClient();
try {
  const result = await callToolRecord(client, "proxmox_vm_action", {
    cluster: "default",
    vmid: 94207,
    action: "stop",
    waitMode: "wait",
    timeoutMs: 120000,
    pollIntervalMs: 1000,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
'@ | npx tsx -
```

When validating a module, the preferred proof is:

- perform the action through typed MCP or documented generic MCP tools
- read back the resulting state through MCP
- record any gaps found in the module/tool surface

## Deferred Job Boundary

Deferred jobs are not uniformly durable.

- UPID-backed tool calls can be resumed later through `job_get`, `job_wait`, `job_cancel`, and `job_logs`
- process-run execution paths such as `proxmox_cli_run`, `proxmox_shell_run`, `proxmox_node_terminal_run`, and `proxmox_vm_guest_exec` remain tied to the current live server process
- this repo does not create its own local durable job database; cross-session durability is only available where Proxmox already owns the underlying task

## Rules For Workarounds During Testing

For Proxmox-related actions under module development:

- do not silently switch to raw SSH, shell, or manual node commands just to get the task done
- do not treat an out-of-band workaround as proof that the MCP module works
- if the action should obviously be reusable, stop and add or improve a generic MCP module/tool instead

Examples of actions that should become generic modules or generic typed tool behavior:

- VM/template creation and cloning
- storage operations
- user or token lifecycle management
- cluster and HA workflows
- networking or firewall configuration
- repeatable cloud-init or provisioning actions

## When A Workaround Is Still Acceptable

Sometimes it is not yet clear whether the action belongs in the permanent MCP surface or is just a one-off operator task.

In that case:

1. a workaround may be used once to unblock the immediate task
2. the workaround must be called out explicitly
3. after the workaround, stop and ask the user whether this should become a repeatable generic module/tool addition

Do not quietly normalize one-off shell work into the product surface.

## Module Design Rule Reinforced By Testing

Direct MCP testing is also where we enforce the framework design rules:

- modules should expose low-level generic typed tools, not preset-bound or narrowly scripted operator workflows
- the target shape is an MCP facade over Proxmox resources and operations, not a library of prebuilt recipes
- REST should be preferred whenever the documented Proxmox API already covers the workflow
- SSH/CLI/shell/file should be fallback-only for validated gaps
- convenience wrappers should sit on top of generic typed workflows, not replace them

If a direct MCP test reveals that a maintainer can only complete a clearly reusable Proxmox task by using SSH manually, that is a signal to improve the MCP module rather than to keep the workaround.

When a new typed tool or module is added as a result, the touched public tool registrations and service methods should include provenance comments describing the endpoint families or fallback transports they use.

## What To Record After A Test

After direct MCP validation, capture:

- which MCP tool(s) were used
- whether the test was read-only or mutating
- the exact Proxmox-side outcome
- whether any fallback transport was required
- whether the gap should become:
  - a generic typed module/tool improvement, or
  - a documented one-off operator workaround

This keeps the validated module boundary honest and prevents drift between the docs, code, and real operator workflow.
