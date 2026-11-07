import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";

const admin = plugin.routes.admin.handler;
const editorPanel = plugin.routes["editor/assistant"].handler;

function createHost({
  role = 50,
  initialConnection = null,
  initialProposals = [],
  collections = [
    { slug: "pages", label: "Pages" },
    { slug: "posts", label: "Blog Posts" },
  ],
} = {}) {
  const stored = new Map();
  if (initialConnection) {
    stored.set("connection", { value: JSON.stringify(initialConnection), revision: "1" });
  }
  const kv = new Map();
  if (initialProposals.length > 0) {
    kv.set("pending_proposals", initialProposals);
  }
  let revisions = 1;
  const ctx = {
    plugin: { id: "dinkus-pi-durable", version: "0.0.0" },
    site: { url: "https://site.example.test", name: "Example Site", locale: "en" },
    schema: {
      listCollections: async () => collections,
    },
    settings: {
      get: async name => stored.get(name)?.value ?? null,
      delete: async name => stored.delete(name),
      getVersioned: async name => stored.get(name) ?? null,
      compareAndSet: async (name, revision, value) => {
        if ((stored.get(name)?.revision ?? null) !== revision) return { applied: false };
        stored.set(name, { value, revision: String(++revisions) });
        return { applied: true };
      },
    },
    kv: {
      get: async name => (kv.has(name) ? kv.get(name) : null),
      set: async (name, value) => {
        kv.set(name, value);
      },
      delete: async name => kv.delete(name),
    },
    http: {
      fetch: async () => Response.json({ ok: true }),
    },
    log: { error() {}, info() {}, warn() {}, debug() {} },
  };
  const route = (input, entry = undefined) => ({
    input,
    ui: { surface: entry ? "editor-panel" : "admin-page", locale: "en", direction: "ltr", ...(entry ? { entry } : {}) },
    user: { id: "u1", email: "owner@example.test", name: "Owner", role, createdAt: "" },
    request: { url: "https://site.example.test/_emdash/api/plugins/dinkus-pi-durable/admin", method: "POST", headers: {} },
  });
  return { ctx, route, stored, kv };
}

test("refuses callers below Editor role with valid Block Kit", async () => {
  const { ctx, route } = createHost({ role: 10 });
  const response = await admin(route({ type: "page_load" }), ctx);
  assert.doesNotThrow(() => validateBlockResponse(response));
  assert.equal(response.blocks[1].type, "banner");
  assert.equal(response.blocks[1].title, "Permission denied");
});

test("renders 1-Click Deploy to Cloudflare button and dynamic collection toggles on setup", async () => {
  const { ctx, route } = createHost({
    role: 50,
    collections: [
      { slug: "pages", label: "Pages" },
      { slug: "case_studies", label: "Case Studies" },
    ],
  });
  const initial = await admin(route({ type: "page_load" }), ctx);
  assert.doesNotThrow(() => validateBlockResponse(initial));
  const actionsBlock = initial.blocks.find(b => b.type === "actions");
  assert.ok(actionsBlock);
  assert.equal(actionsBlock.elements[0].type, "link");
  assert.equal(actionsBlock.elements[0].label, "1-Click Deploy Pi Worker to Cloudflare");

  const form = initial.blocks.find(b => b.type === "form" && b.block_id === "pi-durable-connect-form");
  assert.ok(form);
  assert.equal(form.fields.some(f => f.action_id === "col_case_studies"), true);

  const connected = await admin(
    route({
      type: "form_submit",
      action_id: "save_connection",
      values: {
        workerUrl: "https://pi-durable-assistant.example.workers.dev",
        model: "openai-codex/gpt-6.1-sol:high",
        workerToken: "pi_do_test_token_123",
        authorityMode: "propose_with_approval",
        col_pages: true,
        col_case_studies: false,
      },
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(connected));
  assert.equal(connected.toast?.type, "success");
});

test("supports live mid-task steer and configurable editor side-panel collaboration", async () => {
  const { ctx, route } = createHost({
    role: 50,
    initialConnection: {
      workerUrl: "https://pi-durable-assistant.example.workers.dev",
      model: "openai-codex/gpt-6.1-sol:high",
      workerToken: "pi_do_test_token_123",
      authorityMode: "propose_with_approval",
      enabledCollections: ["pages"],
    },
  });

  const started = await admin(
    route({
      type: "form_submit",
      action_id: "ask_agent",
      values: { prompt: "Summarize SEO gaps across landing pages" },
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(started));
  assert.equal(
    started.blocks.some(b => b.type === "form" && b.block_id === "pi-durable-steer-form"),
    true,
  );

  const steered = await admin(
    route({
      type: "form_submit",
      action_id: "steer_agent",
      values: { steerMessage: "Prioritize the About page" },
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(steered));
  assert.equal(steered.toast?.type, "info");

  const pagesPanel = await editorPanel(
    route({ type: "panel_load" }, { collection: "pages", id: "about", locale: "en", version: 1 }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(pagesPanel));
  assert.equal(pagesPanel.blocks.some(b => b.type === "form" && b.block_id === "pi-durable-entry-form"), true);
});
