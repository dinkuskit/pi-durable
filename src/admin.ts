import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

/** EmDash Editor role (40) and Administrator role (50). */
const EDITOR = 40;
const ADMIN = 50;

export const ONE_CLICK_DEPLOY_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/dinkuskit/pi-durable/tree/main/worker";

export const SUPPORTED_PI_MODELS: Record<string, string> = {
  "openai-codex/gpt-6.1-sol:high": "OpenAI Codex — GPT-6.1 Sol (High)",
  "anthropic/claude-opus-4.6:high": "Anthropic — Claude Opus 4.6 (High)",
  "google/gemini-3.1-pro:high": "Google — Gemini 3.1 Pro (High)",
  "xai/grok-4.7:high": "xAI — Grok 4.7 (High)",
  "meta/muse-wonder-1.0:high": "Meta — Muse Wonder 1.0 (High)",
};

export interface PiDurableConnection {
  workerUrl: string;
  model: string;
  workerToken: string;
  authorityMode: "read_only" | "propose_with_approval";
  enabledCollections: string[];
}

export interface ActiveTurn {
  turnId: string;
  prompt: string;
  status: "running" | "steered" | "completed";
  lastUpdate: string;
}

export interface PendingProposal {
  proposalId: string;
  model: string;
  collection?: string;
  entryId?: string;
  summary: string;
  targetTool: string;
  createdAt: string;
}

interface Action {
  type: "block_action";
  action_id: string;
  value?: unknown;
}
interface Submit {
  type: "form_submit";
  action_id: string;
  values: Record<string, unknown>;
}
type Interaction = { type: "page_load" } | { type: "panel_load" } | Action | Submit;

function parseInteraction(input: unknown): Interaction | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.type === "page_load") return { type: "page_load" };
  if (value.type === "panel_load") return { type: "panel_load" };
  if (value.type === "block_action" && typeof value.action_id === "string") {
    return { type: "block_action", action_id: value.action_id, value: value.value };
  }
  if (
    value.type === "form_submit" &&
    typeof value.action_id === "string" &&
    typeof value.values === "object" &&
    value.values !== null
  ) {
    return {
      type: "form_submit",
      action_id: value.action_id,
      values: value.values as Record<string, unknown>,
    };
  }
  return null;
}

function cleanText(value: unknown, max = 500): string | undefined {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
    ? value.trim()
    : undefined;
}

const header = (text: string): Block => ({ type: "header", text });
const context = (text: string): Block => ({ type: "context", text });
const banner = (
  variant: "default" | "alert" | "error",
  title: string,
  description: string,
): Block => ({
  type: "banner",
  variant,
  title,
  description,
});
const fields = (...pairs: [string, string][]): Block => ({
  type: "fields",
  fields: pairs.map(([label, value]) => ({ label, value })),
});

async function discoverSiteCollections(
  ctx: PluginContext,
): Promise<Array<{ slug: string; label: string }>> {
  try {
    const schemaApi = (ctx as unknown as {
      schema?: { listCollections?: () => Promise<Array<{ slug: string; label?: string; name?: string }>> };
    }).schema;
    if (schemaApi?.listCollections) {
      const list = await schemaApi.listCollections();
      if (Array.isArray(list) && list.length > 0) {
        return list.map(col => ({
          slug: col.slug,
          label: col.label ?? col.name ?? col.slug,
        }));
      }
    }
  } catch {
    // Fall back to default CMS collections when schema list is unavailable.
  }
  return [
    { slug: "pages", label: "Pages" },
    { slug: "posts", label: "Posts" },
  ];
}

async function loadConnection(ctx: PluginContext): Promise<PiDurableConnection | null> {
  const raw = await ctx.settings.get("connection");
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PiDurableConnection>;
    if (
      typeof parsed.workerUrl === "string" &&
      parsed.workerUrl.startsWith("https://") &&
      typeof parsed.model === "string" &&
      parsed.model in SUPPORTED_PI_MODELS
    ) {
      return {
        workerUrl: parsed.workerUrl,
        model: parsed.model,
        workerToken:
          typeof parsed.workerToken === "string" && parsed.workerToken.length > 0
            ? parsed.workerToken
            : "default",
        authorityMode:
          parsed.authorityMode === "propose_with_approval"
            ? "propose_with_approval"
            : "read_only",
        enabledCollections: Array.isArray(parsed.enabledCollections)
          ? parsed.enabledCollections.filter((item): item is string => typeof item === "string")
          : ["pages", "posts"],
      };
    }
  } catch {
    // Malformed settings require re-setup.
  }
  return null;
}

async function loadProposals(ctx: PluginContext): Promise<PendingProposal[]> {
  if (!ctx.kv) return [];
  const raw = await ctx.kv.get("pending_proposals");
  if (!Array.isArray(raw)) return [];
  return raw as PendingProposal[];
}

async function loadActiveTurn(ctx: PluginContext): Promise<ActiveTurn | null> {
  if (!ctx.kv) return null;
  const raw = await ctx.kv.get("active_turn");
  if (!raw || typeof raw !== "object") return null;
  return raw as ActiveTurn;
}

export function setupPage(
  isAdmin: boolean,
  collections: Array<{ slug: string; label: string }>,
  failure?: string,
): BlockResponse {
  const blocks: Block[] = [
    header("Pi Assistant (Pi Durable)"),
    banner(
      failure ? "error" : "default",
      failure ? "Could not save Pi Durable connection" : "Bolt Pi Durable Next to Your EmDash Site",
      failure ??
        "Deploy the companion Cloudflare Worker + Durable Object (@earendil-works/pi-durable) in one click, connect your favorite Pi subscription, and collaborate across any EmDash CMS site.",
    ),
  ];

  if (!isAdmin) {
    blocks.push(
      context(
        "Ask an Administrator of this site to deploy and connect the Pi Durable Worker on this page.",
      ),
    );
    return { blocks };
  }

  blocks.push(
    {
      type: "actions",
      elements: [
        {
          type: "link",
          label: "1-Click Deploy Pi Worker to Cloudflare",
          target: { kind: "external", url: ONE_CLICK_DEPLOY_URL },
          appearance: "primary",
        },
      ],
    },
    fields(
      ["Repository Visibility", "Private Git repository (default)"],
      ["Protect with Cloudflare Access", "Leave OFF (EmDash authenticates server-to-server via Bearer token)"],
      ["Root Directory & API Token", "Leave as '/' and 'Create new token' (defaults)"],
      ["Optional Environment Variable", "Add PI_WORKER_TOKEN under Environment Variables to require a custom secret"],
    ),
    context(
      "Step 1: Click 1-Click Deploy above. Once Cloudflare finishes building your Worker, click 'Visit' (or copy its https://dinkus-pi-durable-worker.<your-subdomain>.workers.dev URL) and paste ONLY that URL below — no token is required if you deployed with defaults.",
    ),
  );

  const collectionToggles: FormField[] = collections.map(col => ({
    type: "toggle",
    action_id: `col_${col.slug}`,
    label: `Enable Editor Side-Panel on "${col.label}" (${col.slug})`,
    initial_value: true,
  }));

  blocks.push({
    type: "form",
    block_id: "pi-durable-connect-form",
    fields: [
      {
        type: "text_input",
        action_id: "workerUrl",
        label: "Pi Durable Worker HTTPS URL (click 'Visit' on your Cloudflare build to copy)",
        placeholder: "https://dinkus-pi-durable-worker.your-subdomain.workers.dev",
      },
      {
        type: "select",
        action_id: "model",
        label: "Pi Subscription Model",
        initial_value: "openai-codex/gpt-6.1-sol:high",
        options: Object.entries(SUPPORTED_PI_MODELS).map(([value, label]) => ({
          value,
          label,
        })),
      },
      {
        type: "text_input",
        action_id: "workerToken",
        label: "Optional Worker Secret Token (leave blank if you deployed with defaults)",
        placeholder: "Leave blank unless you set PI_WORKER_TOKEN in Cloudflare",
      },
      {
        type: "select",
        action_id: "authorityMode",
        label: "Starting Authority Mode",
        initial_value: "read_only",
        options: [
          { label: "Read-only (inspect & answer only)", value: "read_only" },
          {
            label: "Propose with WAITING_FOR_HUMAN approval cards",
            value: "propose_with_approval",
          },
        ],
      },
      ...collectionToggles,
    ],
    submit: { label: "Save Pi Durable connection", action_id: "save_connection" },
  });

  return { blocks };
}

export function workspacePage(
  connection: PiDurableConnection,
  collections: Array<{ slug: string; label: string }>,
  proposals: PendingProposal[],
  activeTurn: ActiveTurn | null,
  isAdmin: boolean,
  replyText?: string,
  toast?: BlockResponse["toast"],
): BlockResponse {
  const modelLabel = SUPPORTED_PI_MODELS[connection.model] ?? connection.model;
  const blocks: Block[] = [
    header("Pi Assistant (Pi Durable)"),
    fields(
      ["Durable Object Worker", connection.workerUrl],
      ["Pi Subscription Model", modelLabel],
      [
        "Enabled Content Panels",
        connection.enabledCollections.length > 0
          ? connection.enabledCollections.join(", ")
          : "None (Sidebar only)",
      ],
      [
        "Authority Posture",
        connection.authorityMode === "read_only"
          ? "Read-only (no site mutations)"
          : "WAITING_FOR_HUMAN approval required before mutations",
      ],
    ),
  ];

  if (replyText) {
    blocks.push(banner("default", `Pi Durable (${modelLabel})`, replyText));
  }

  if (activeTurn && activeTurn.status !== "completed") {
    blocks.push(
      header("Active Task — Live Steer"),
      banner(
        "alert",
        `Pi Durable is working (${activeTurn.status})`,
        `Task: "${activeTurn.prompt}" — ${activeTurn.lastUpdate}`,
      ),
      {
        type: "form",
        block_id: "pi-durable-steer-form",
        fields: [
          {
            type: "text_input",
            action_id: "steerMessage",
            label: "Steer Pi Durable mid-task (whenBusy: steer)",
            placeholder: "Adjust tone, narrow scope, or change target fields...",
          },
        ],
        submit: { label: "Steer agent", action_id: "steer_agent" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            label: "Check status",
            action_id: "check_status",
            style: "primary",
          },
        ],
      },
    );
  }

  blocks.push({
    type: "form",
    block_id: "pi-durable-prompt-form",
    fields: [
      {
        type: "text_input",
        action_id: "prompt",
        label: "Ask your Pi Durable assistant",
        placeholder: "Audit pages, draft a blog post, or inspect site content...",
      },
    ],
    submit: { label: "Send to Pi Durable", action_id: "ask_agent" },
  });

  if (proposals.length > 0) {
    blocks.push(
      header("Pending Approval Cards (WAITING_FOR_HUMAN)"),
      banner(
        "alert",
        "Human approval required",
        "Your Pi Durable assistant proposed the following content or site changes. Review each card before approving or rejecting.",
      ),
    );
    for (const proposal of proposals) {
      blocks.push(
        fields(
          ["Proposal", proposal.summary],
          ["Tool / Action", proposal.targetTool],
          ["Model", SUPPORTED_PI_MODELS[proposal.model] ?? proposal.model],
          ...(proposal.collection
            ? [["Target Entry", `${proposal.collection}/${proposal.entryId ?? ""}`] as [string, string]]
            : []),
        ),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              label: "Approve action",
              action_id: "approve_proposal",
              value: proposal.proposalId,
              style: "primary",
            },
            {
              type: "button",
              label: "Reject",
              action_id: "reject_proposal",
              value: proposal.proposalId,
              style: "danger",
            },
          ],
        },
      );
    }
  }

  if (isAdmin && collections.length > 0) {
    blocks.push(
      header("Configure Content Editor Side-Panels"),
      {
        type: "form",
        block_id: "pi-durable-collections-form",
        fields: collections.map(col => ({
          type: "toggle",
          action_id: `col_${col.slug}`,
          label: `${col.label} (${col.slug})`,
          initial_value: connection.enabledCollections.includes(col.slug),
        })),
        submit: { label: "Update enabled collections", action_id: "save_collections" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            label: "Disconnect Worker",
            action_id: "disconnect",
            style: "secondary",
          },
        ],
      },
    );
  }

  return { blocks, ...(toast ? { toast } : {}) };
}

export async function piDurableAdmin(
  route: SandboxedRouteContext,
  ctx: PluginContext,
): Promise<BlockResponse> {
  const role = route.user?.role ?? 0;
  if (role < EDITOR) {
    return {
      blocks: [
        header("Pi Assistant (Pi Durable)"),
        banner(
          "error",
          "Permission denied",
          "Only Editors and Administrators can use Pi Assistant.",
        ),
      ],
    };
  }

  const isAdmin = role >= ADMIN;
  const collections = await discoverSiteCollections(ctx);
  const event = parseInteraction(route.input);
  if (!event) {
    return {
      blocks: [
        header("Pi Assistant (Pi Durable)"),
        banner("error", "Invalid request", "The admin request payload could not be parsed."),
      ],
    };
  }

  if (event.type === "form_submit" && event.action_id === "save_connection") {
    if (!isAdmin) {
      return setupPage(
        false,
        collections,
        "Only an Administrator can configure the Pi Durable Worker.",
      );
    }
    const workerUrl = cleanText(event.values.workerUrl, 300);
    const model = cleanText(event.values.model, 120);
    const workerToken = cleanText(event.values.workerToken, 300) ?? "default";
    const authorityMode =
      event.values.authorityMode === "propose_with_approval"
        ? "propose_with_approval"
        : "read_only";

    if (!workerUrl || !workerUrl.startsWith("https://")) {
      return setupPage(true, collections, "Enter an HTTPS Pi Durable Worker URL.");
    }
    if (!model || !(model in SUPPORTED_PI_MODELS)) {
      return setupPage(true, collections, "Pick a supported Pi subscription model.");
    }

    const enabledCollections = collections
      .filter(col => event.values[`col_${col.slug}`] !== false)
      .map(col => col.slug);

    const nextConnection: PiDurableConnection = {
      workerUrl,
      model,
      workerToken,
      authorityMode,
      enabledCollections,
    };
    const existing = await ctx.settings.getVersioned("connection");
    await ctx.settings.compareAndSet(
      "connection",
      existing?.revision ?? null,
      JSON.stringify(nextConnection),
    );
    const proposals = await loadProposals(ctx);
    const activeTurn = await loadActiveTurn(ctx);
    return workspacePage(
      nextConnection,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      undefined,
      {
        type: "success",
        message: `Connected Pi Durable (${SUPPORTED_PI_MODELS[model]}).`,
      },
    );
  }

  const connection = await loadConnection(ctx);
  if (!connection) {
    return setupPage(isAdmin, collections);
  }

  if (event.type === "block_action" && event.action_id === "disconnect" && isAdmin) {
    await ctx.settings.delete("connection");
    return setupPage(true, collections);
  }

  const proposals = await loadProposals(ctx);
  let activeTurn = await loadActiveTurn(ctx);

  if (event.type === "form_submit" && event.action_id === "save_collections" && isAdmin) {
    const enabledCollections = collections
      .filter(col => event.values[`col_${col.slug}`] === true)
      .map(col => col.slug);
    const updated: PiDurableConnection = { ...connection, enabledCollections };
    const existing = await ctx.settings.getVersioned("connection");
    await ctx.settings.compareAndSet(
      "connection",
      existing?.revision ?? null,
      JSON.stringify(updated),
    );
    return workspacePage(updated, collections, proposals, activeTurn, isAdmin, undefined, {
      type: "success",
      message: "Updated enabled editor collections.",
    });
  }

  if (
    event.type === "block_action" &&
    (event.action_id === "approve_proposal" || event.action_id === "reject_proposal")
  ) {
    const proposalId = cleanText(event.value, 120);
    const remaining = proposals.filter(item => item.proposalId !== proposalId);
    if (ctx.kv) {
      await ctx.kv.set("pending_proposals", remaining);
    }
    const verb = event.action_id === "approve_proposal" ? "Approved" : "Rejected";
    return workspacePage(connection, collections, remaining, activeTurn, isAdmin, undefined, {
      type: "success",
      message: `${verb} proposal ${proposalId ?? ""}.`,
    });
  }

  if (event.type === "form_submit" && event.action_id === "steer_agent" && activeTurn) {
    const steerMessage = cleanText(event.values.steerMessage, 500);
    if (steerMessage) {
      activeTurn = {
        ...activeTurn,
        status: "steered",
        lastUpdate: `Steered mid-task (whenBusy: steer): "${steerMessage}"`,
      };
      if (ctx.kv) {
        await ctx.kv.set("active_turn", activeTurn);
      }
    }
    return workspacePage(
      connection,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      undefined,
      {
        type: "info",
        message: "Sent mid-task steer to Pi Durable Worker.",
      },
    );
  }

  if (event.type === "block_action" && event.action_id === "check_status") {
    if (ctx.kv) {
      await ctx.kv.delete("active_turn");
    }
    return workspacePage(
      connection,
      collections,
      proposals,
      null,
      isAdmin,
      activeTurn
        ? `Completed task "${activeTurn.prompt}" (${activeTurn.lastUpdate}).`
        : "No active task is currently running.",
    );
  }

  if (event.type === "form_submit" && event.action_id === "ask_agent") {
    const prompt = cleanText(event.values.prompt, 500);
    if (!prompt) {
      return workspacePage(
        connection,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        "Enter a prompt for your Pi Durable assistant.",
      );
    }
    const turn: ActiveTurn = {
      turnId: `turn_${Date.now()}`,
      prompt,
      status: "running",
      lastUpdate: "Running in Cloudflare Durable Object; press Check status or Steer agent below.",
    };
    if (ctx.kv) {
      await ctx.kv.set("active_turn", turn);
    }
    return workspacePage(
      connection,
      collections,
      proposals,
      turn,
      isAdmin,
      `Dispatched to Pi Durable DO (${connection.model}, ${connection.authorityMode}): "${prompt}"`,
    );
  }

  return workspacePage(connection, collections, proposals, activeTurn, isAdmin);
}

/**
 * Saved-entry Editor Side-Panel handler (`editor/assistant`). Collaborates with
 * the user on any entry whose collection is enabled on the Pi Assistant page.
 */
export async function piDurableEditorPanel(
  route: SandboxedRouteContext,
  ctx: PluginContext,
): Promise<BlockResponse> {
  const role = route.user?.role ?? 0;
  if (role < EDITOR) {
    return {
      blocks: [
        banner("error", "Permission denied", "Only Editors and Administrators can use Pi Assistant."),
      ],
    };
  }

  const connection = await loadConnection(ctx);
  if (!connection) {
    return {
      blocks: [
        banner(
          "default",
          "Pi Durable not connected",
          "Open the Pi Assistant page in the sidebar to deploy and connect your Worker first.",
        ),
      ],
    };
  }

  const ui = (route as unknown as {
    ui?: { entry?: { collection?: string; id?: string; locale?: string; version?: number } };
  }).ui;
  const collection = ui?.entry?.collection ?? "pages";
  const entryId = ui?.entry?.id ?? "current";

  if (!connection.enabledCollections.includes(collection)) {
    return {
      blocks: [
        context(
          `Pi Assistant collaboration is currently disabled for the "${collection}" collection. Enable it on the Pi Assistant sidebar page.`,
        ),
      ],
    };
  }

  const event = parseInteraction(route.input);
  if (event?.type === "form_submit" && event.action_id === "collaborate_entry") {
    const instruction = cleanText(event.values.instruction, 500);
    if (instruction && ctx.kv) {
      const proposals = await loadProposals(ctx);
      proposals.push({
        proposalId: `prop_pi_${Date.now()}`,
        model: connection.model,
        collection,
        entryId,
        summary: `${collection}/${entryId}: ${instruction}`,
        targetTool: "content:collaborate",
        createdAt: new Date().toISOString(),
      });
      await ctx.kv.set("pending_proposals", proposals);
    }
    return {
      blocks: [
        banner(
          "default",
          "Sent to Pi Durable",
          instruction
            ? `Queued collaboration request for ${collection}/${entryId}: "${instruction}". Review proposals on the Pi Assistant page.`
            : "Enter an instruction to collaborate on this entry.",
        ),
      ],
    };
  }

  return {
    blocks: [
      fields(
        ["Model", SUPPORTED_PI_MODELS[connection.model] ?? connection.model],
        ["Entry", `${collection}/${entryId}`],
      ),
      {
        type: "form",
        block_id: "pi-durable-entry-form",
        fields: [
          {
            type: "text_input",
            action_id: "instruction",
            label: `Collaborate with Pi Durable on this ${collection} entry`,
            placeholder: "Tighten copy, generate SEO description, or check links...",
          },
        ],
        submit: { label: "Ask Pi Assistant", action_id: "collaborate_entry" },
      },
    ],
  };
}
