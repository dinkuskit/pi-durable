import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

/** EmDash Editor role (40) and Administrator role (50). */
const EDITOR = 40;
const ADMIN = 50;

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
}

export interface PendingProposal {
  proposalId: string;
  model: string;
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
type Interaction = { type: "page_load" } | Action | Submit;

function parseInteraction(input: unknown): Interaction | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.type === "page_load") return { type: "page_load" };
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

async function loadConnection(ctx: PluginContext): Promise<PiDurableConnection | null> {
  const raw = await ctx.settings.get("connection");
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PiDurableConnection>;
    if (
      typeof parsed.workerUrl === "string" &&
      parsed.workerUrl.startsWith("https://") &&
      typeof parsed.model === "string" &&
      parsed.model in SUPPORTED_PI_MODELS &&
      typeof parsed.workerToken === "string" &&
      parsed.workerToken.length > 0
    ) {
      return {
        workerUrl: parsed.workerUrl,
        model: parsed.model,
        workerToken: parsed.workerToken,
        authorityMode:
          parsed.authorityMode === "propose_with_approval"
            ? "propose_with_approval"
            : "read_only",
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

export function setupPage(isAdmin: boolean, failure?: string): BlockResponse {
  const blocks: Block[] = [
    header("Pi Assistant (Pi Durable)"),
    banner(
      failure ? "error" : "default",
      failure ? "Could not save Pi Durable connection" : "Bolt Pi Durable Next to Your EmDash Site",
      failure ??
        "Connect your companion Cloudflare Worker + Durable Object (@earendil-works/pi-durable) and choose your Pi-supported subscription model. Starts read-only with WAITING_FOR_HUMAN approval cards.",
    ),
  ];

  if (!isAdmin) {
    blocks.push(
      context(
        "Ask an Administrator of this site to connect the companion Pi Durable Worker on this page.",
      ),
    );
    return { blocks };
  }

  blocks.push({
    type: "form",
    block_id: "pi-durable-connect-form",
    fields: [
      {
        type: "text_input",
        action_id: "workerUrl",
        label: "Pi Durable Worker HTTPS URL",
        placeholder: "https://dinkuskit.com/api/pi-durable",
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
        label: "Worker / Subscription Secret Token",
        placeholder: "pi_do_live_...",
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
    ],
    submit: { label: "Save Pi Durable connection", action_id: "save_connection" },
  });

  return { blocks };
}

export function workspacePage(
  connection: PiDurableConnection,
  proposals: PendingProposal[],
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
      ["Steering Mode", "whenBusy: steer (Durable Object SQLite)"],
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

  blocks.push({
    type: "form",
    block_id: "pi-durable-prompt-form",
    fields: [
      {
        type: "text_input",
        action_id: "prompt",
        label: "Ask or steer your Pi Durable assistant",
        placeholder: "Audit product descriptions, draft a blog post, or inspect orders...",
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
        "Your Pi Durable assistant proposed the following site or store changes. Review each card before approving or rejecting.",
      ),
    );
    for (const proposal of proposals) {
      blocks.push(
        fields(
          ["Proposal", proposal.summary],
          ["Tool / Action", proposal.targetTool],
          ["Model", SUPPORTED_PI_MODELS[proposal.model] ?? proposal.model],
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

  if (isAdmin) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          label: "Disconnect Worker",
          action_id: "disconnect",
          style: "secondary",
        },
      ],
    });
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
      return setupPage(false, "Only an Administrator can configure the Pi Durable Worker.");
    }
    const workerUrl = cleanText(event.values.workerUrl, 300);
    const model = cleanText(event.values.model, 120);
    const workerToken = cleanText(event.values.workerToken, 300);
    const authorityMode =
      event.values.authorityMode === "propose_with_approval"
        ? "propose_with_approval"
        : "read_only";

    if (!workerUrl || !workerUrl.startsWith("https://")) {
      return setupPage(true, "Enter an HTTPS Pi Durable Worker URL.");
    }
    if (!model || !(model in SUPPORTED_PI_MODELS)) {
      return setupPage(true, "Pick a supported Pi subscription model.");
    }
    if (!workerToken) {
      return setupPage(true, "Enter your Pi Durable Worker / subscription token.");
    }

    const nextConnection: PiDurableConnection = {
      workerUrl,
      model,
      workerToken,
      authorityMode,
    };
    const existing = await ctx.settings.getVersioned("connection");
    await ctx.settings.compareAndSet(
      "connection",
      existing?.revision ?? null,
      JSON.stringify(nextConnection),
    );
    const proposals = await loadProposals(ctx);
    return workspacePage(nextConnection, proposals, isAdmin, undefined, {
      type: "success",
      message: `Connected Pi Durable (${SUPPORTED_PI_MODELS[model]}).`,
    });
  }

  const connection = await loadConnection(ctx);
  if (!connection) {
    return setupPage(isAdmin);
  }

  if (event.type === "block_action" && event.action_id === "disconnect" && isAdmin) {
    await ctx.settings.delete("connection");
    return setupPage(true);
  }

  const proposals = await loadProposals(ctx);

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
    return workspacePage(connection, remaining, isAdmin, undefined, {
      type: "success",
      message: `${verb} proposal ${proposalId ?? ""}.`,
    });
  }

  if (event.type === "form_submit" && event.action_id === "ask_agent") {
    const prompt = cleanText(event.values.prompt, 500);
    if (!prompt) {
      return workspacePage(
        connection,
        proposals,
        isAdmin,
        "Enter a prompt or steer instruction for your Pi Durable assistant.",
      );
    }
    return workspacePage(
      connection,
      proposals,
      isAdmin,
      `Dispatched to Pi Durable DO (${connection.model}, ${connection.authorityMode}): "${prompt}"`,
    );
  }

  return workspacePage(connection, proposals, isAdmin);
}
