# Companion Cloudflare Worker + Durable Object (`@earendil-works/pi-durable`)

This directory houses the companion Cloudflare Worker + Durable Object template
that deploys alongside an EmDash CMS Worker.

## Runtime shape

- **Durable Object class:** `@earendil-works/pi-durable` + `@mariozechner/pi-agent-core`
  using Durable Object SQLite (`ctx.storage.sql`) and `whenBusy: "steer"`.
- **Subscription models:** Supports Pi-compatible subscriptions/API keys
  (`openai-codex/gpt-6.1-sol:high`, `anthropic/claude-opus-4.6:high`,
  `google/gemini-3.1-pro:high`, `xai/grok-4.7:high`, `meta/muse-wonder-1.0:high`).
- **EmDash integration:** Connects back to the site's permissioned EmDash MCP
  server and posts `WAITING_FOR_HUMAN` approval cards to the `dinkus-pi-durable`
  Block Kit admin page before executing any mutation.
