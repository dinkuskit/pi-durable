# Agent Contract

This public repository owns `@dinkuskit/pi-durable` (`dinkus-pi-durable`), the
open-source EmDash plugin that bolts a serverless Pi Durable agent
(`@earendil-works/pi-durable` + `@mariozechner/pi-agent-core` on Cloudflare
Workers & Durable Objects) next to an EmDash CMS site with BYO Pi subscriptions.
Assume every committed byte is immediately public.

## Source priority

1. This file.
2. `docs/CHARTER.md` (once grilled and locked).
3. `.grilltrack/ledger.json`, maintained only through the GrillTrack CLI.
4. Current source, tests, and committed proof.

## Public-safe boundary

- Never commit credentials, subscription tokens, API keys, environment files,
  customer or tenant data, private Tailscale/SSH hostnames, private repository
  coordinates, or private operating rationale.
- This repository has an independent Git root. Never merge, cherry-pick,
  subtree, fork, bundle, or otherwise import unrelated repository history.

## Architectural invariants

- **Two-part split (Sandboxed Registry Plugin + Companion Durable Object Worker):**
  - The EmDash Registry plugin (`src/plugin.ts`, slug `dinkus-pi-durable`) runs
    inside EmDash's capability-gated isolate (`< 128 KiB` `backend.js` cap,
    Block Kit UI only) and acts as the setup surface, draft patch bridge
    (`admin.editor-draft:read` / `admin.editor-draft:patch`), and
    `WAITING_FOR_HUMAN` approval gate.
  - The `pi-durable` runtime (`worker/`) runs in a companion Cloudflare Worker +
    Durable Object (`ctx.storage.sql`, `whenBusy: "steer"`) co-located with the
    site's Cloudflare account and connects back through EmDash's permissioned
    MCP server.
- **No plugin-to-plugin imports in the sandbox:** Never import or call other
  plugins directly inside `backend.js`; discover site and commerce capabilities
  through EmDash MCP tools.
- **Read-only start & `WAITING_FOR_HUMAN` approval cards:** Assistant access
  starts read-only by default. Mutations require explicit per-business authority
  and human approval cards.

## Bootstrap state and gates

- Public scaffold (`0.0.0`, `"private": true`). Keep out of the DinkusKit v1
  store launch critical path (`Commerce`, `Payments`, `Ship`).
- Run `bin/verify-pi-durable quick` before every commit.
- Do not publish to npm, list in an EmDash marketplace or registry, deploy,
  merge, or mutate a production site without explicit owner approval.
