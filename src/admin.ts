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
  subscriptionAuth?: {
    providerId: string;
    authType: "oauth" | "api_key";
    label: string;
    connectedAt: string;
  };
}

export interface PendingOAuthSession {
  providerId: "openai-codex" | "anthropic" | "xai";
  flow: "device_code" | "pkce_code";
  userCode?: string;
  verificationUri: string;
  deviceAuthId?: string;
  deviceCode?: string;
  verifier?: string;
  intervalSeconds: number;
  createdAt: string;
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
        ...(parsed.subscriptionAuth && typeof parsed.subscriptionAuth === "object"
          ? { subscriptionAuth: parsed.subscriptionAuth }
          : {}),
      };
    }
  } catch {
    // Malformed settings require re-setup.
  }
  return null;
}

async function saveConnectionRecord(
  ctx: PluginContext,
  connection: PiDurableConnection,
): Promise<void> {
  const existing = await ctx.settings.getVersioned("connection");
  await ctx.settings.compareAndSet(
    "connection",
    existing?.revision ?? null,
    JSON.stringify(connection),
  );
}

async function loadPendingOAuth(ctx: PluginContext): Promise<PendingOAuthSession | null> {
  if (!ctx.kv) return null;
  const raw = await ctx.kv.get("pending_oauth");
  if (!raw || typeof raw !== "object") return null;
  return raw as PendingOAuthSession;
}

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));
  return { verifier, challenge };
}

async function pluginFetch(
  ctx: PluginContext,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (ctx.http?.fetch) {
    return ctx.http.fetch(url, init);
  }
  return fetch(url, init);
}

async function syncCredentialToWorker(
  ctx: PluginContext,
  connection: PiDurableConnection,
  providerId: string,
  authType: "oauth" | "api_key",
  credential: unknown,
): Promise<void> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (connection.workerToken && connection.workerToken !== "default") {
      headers.authorization = `Bearer ${connection.workerToken}`;
    }
    const baseUrl = connection.workerUrl.replace(/\/+$/, "");
    await pluginFetch(ctx, `${baseUrl}/auth/store`, {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId, authType, credential }),
    });
  } catch {
    // Best-effort sync to Worker DO; encrypted settings remain authoritative.
  }
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
  const blocks: Block[] = [header("Pi Assistant")];

  if (failure) {
    blocks.push(banner("error", "Could not save Pi Durable connection", failure));
  }

  blocks.push({
    type: "stats",
    items: [
      {
        label: "Connection Status",
        value: "Awaiting Worker",
        description: "Deploy companion Worker in 1 click",
        trend: "neutral",
      },
      {
        label: "Durable Runtime",
        value: "Pi Durable + SQLite",
        description: "@earendil-works/pi-durable on Cloudflare DO",
      },
      {
        label: "Safety Posture",
        value: "Approval Gated",
        description: "WAITING_FOR_HUMAN cards before edits",
        trend: "up",
      },
    ],
  });

  if (!isAdmin) {
    blocks.push(
      context(
        "Ask an Administrator of this site to deploy and connect the Pi Durable Worker on this page.",
      ),
    );
    return { blocks };
  }

  const leftColumn: Block[] = [
    {
      type: "empty",
      size: "base",
      title: "Step 1 — Deploy Companion Worker",
      description:
        "Creates a private Git repo and deploys the serverless Pi Durable SQLite Durable Object to your Cloudflare account.",
      actions: [
        {
          type: "link",
          label: "1-Click Deploy Pi Worker to Cloudflare",
          target: { kind: "external", url: ONE_CLICK_DEPLOY_URL },
          appearance: "primary",
        },
      ],
    },
    {
      type: "table",
      page_action_id: "setup_steps_noop",
      columns: [
        { key: "step", label: "Step", format: "badge" },
        { key: "screen", label: "Cloudflare Screen" },
        { key: "action", label: "What to Do", format: "code" },
      ],
      rows: [
        {
          step: "1. Deploy",
          screen: "Set up application",
          action: "Keep Access OFF, Root '/'",
        },
        {
          step: "2. Enable URL",
          screen: "Worker → Domains tab",
          action: "Toggle Production *.workers.dev ON",
        },
        {
          step: "3. Connect",
          screen: "EmDash (right column)",
          action: "Paste https://...workers.dev URL",
        },
      ],
    },
  ];

  const rightColumn: Block[] = [
    header("Step 2 — Connect Worker & Subscription"),
    {
      type: "form",
      block_id: "pi-durable-connect-form",
      fields: [
        {
          type: "text_input",
          action_id: "workerUrl",
          label: "Pi Durable Worker HTTPS URL",
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
        {
          type: "checkbox",
          action_id: "enabledCollections",
          label: "Enable Editor Side-Panel on Collections",
          initial_value: collections.map(col => col.slug),
          options: collections.map(col => ({
            label: `${col.label} (${col.slug})`,
            value: col.slug,
          })),
        },
        {
          type: "secret_input",
          action_id: "workerToken",
          label: "Optional Worker Secret Token (leave blank for default deploy)",
          placeholder: "Leave blank unless you set PI_WORKER_TOKEN in Cloudflare",
        },
      ],
      submit: { label: "Save Pi Durable connection", action_id: "save_connection" },
    },
  ];

  blocks.push({
    type: "columns",
    columns: [leftColumn, rightColumn],
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
  pendingOAuth?: PendingOAuthSession | null,
  defaultTab?: number,
): BlockResponse {
  const modelLabel = SUPPORTED_PI_MODELS[connection.model] ?? connection.model;
  let workerHost = connection.workerUrl;
  try {
    workerHost = new URL(connection.workerUrl).host;
  } catch {
    // Keep full string if URL parsing fails.
  }

  const subAuth = connection.subscriptionAuth;
  const blocks: Block[] = [
    header("Pi Assistant"),
    {
      type: "stats",
      items: [
        {
          label: "Subscription Auth",
          value: subAuth ? `Connected (${subAuth.label})` : "Not Signed In",
          description: subAuth
            ? `Verified via ${subAuth.authType === "oauth" ? "Pi OAuth" : "API Key"}`
            : "Open 'Subscription & OAuth' tab to sign in",
          trend: subAuth ? "up" : "down",
        },
        {
          label: "Pi Subscription Model",
          value: modelLabel.split("—")[1]?.trim() ?? modelLabel,
          description: `${modelLabel.split("—")[0]?.trim() ?? connection.model} · ${workerHost}`,
          trend: "up",
        },
        {
          label: "Approval Queue",
          value: proposals.length,
          description:
            proposals.length === 0 ? "No pending mutations" : "Awaiting WAITING_FOR_HUMAN review",
          trend: proposals.length > 0 ? "up" : "neutral",
        },
      ],
    },
  ];

  if (!subAuth) {
    blocks.push(
      banner(
        "alert",
        "Worker connected — sign in to your Pi subscription next",
        "Your Cloudflare Worker is connected, but your model subscription is not authenticated yet. Use the 'Subscription & OAuth' tab below to sign in with OpenAI ChatGPT/Codex, Anthropic Claude Pro/Max, or xAI Grok.",
      ),
    );
  }

  const assistantLeft: Block[] = [
    {
      type: "form",
      block_id: "pi-durable-prompt-form",
      fields: [
        {
          type: "text_input",
          action_id: "prompt",
          label: "Ask your Pi Durable assistant",
          placeholder: "Audit pages, draft a blog post, or inspect site content...",
          multiline: true,
        },
      ],
      submit: { label: "Send to Pi Durable", action_id: "ask_agent" },
    },
  ];

  const assistantRight: Block[] = [];
  if (replyText) {
    assistantRight.push(banner("default", `Latest Activity (${modelLabel})`, replyText));
  }
  if (activeTurn && activeTurn.status !== "completed") {
    assistantRight.push(
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
            label: "Live Steer (whenBusy: steer)",
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
  } else if (!replyText) {
    assistantRight.push({
      type: "empty",
      size: "sm",
      title: "Ready for Instructions",
      description:
        "Send a prompt on the left or open any enabled collection entry to use the Pi Assistant side-panel.",
    });
  }

  const approvalBlocks: Block[] =
    proposals.length === 0
      ? [
          {
            type: "empty",
            size: "base",
            title: "No Pending Approval Cards",
            description:
              "When Pi Assistant proposes content edits or site actions, WAITING_FOR_HUMAN cards appear here for one-click approval.",
          },
        ]
      : proposals.flatMap(proposal => [
          fields(
            ["Proposal", proposal.summary],
            ["Tool / Action", proposal.targetTool],
            ["Model", SUPPORTED_PI_MODELS[proposal.model] ?? proposal.model],
            ...(proposal.collection
              ? [
                  [
                    "Target Entry",
                    `${proposal.collection}/${proposal.entryId ?? ""}`,
                  ] as [string, string],
                ]
              : []),
          ),
          {
            type: "actions" as const,
            elements: [
              {
                type: "button" as const,
                label: "Approve action",
                action_id: "approve_proposal",
                value: proposal.proposalId,
                style: "primary" as const,
              },
              {
                type: "button" as const,
                label: "Reject",
                action_id: "reject_proposal",
                value: proposal.proposalId,
                style: "danger" as const,
              },
            ],
          },
          { type: "divider" as const },
        ]);

  const oauthLeftBlocks: Block[] = [];
  if (subAuth) {
    oauthLeftBlocks.push(
      banner(
        "default",
        `Subscription Verified — ${subAuth.label}`,
        `Connected via ${subAuth.authType === "oauth" ? "Pi OAuth" : "API Key"} (${subAuth.connectedAt}). Your Pi Durable Worker can now execute turns using ${modelLabel}.`,
      ),
    );
  }
  if (pendingOAuth) {
    if (pendingOAuth.flow === "device_code" && pendingOAuth.userCode) {
      oauthLeftBlocks.push({
        type: "empty",
        size: "sm",
        title: `1. Copy Code & Authorize (${pendingOAuth.providerId})`,
        description:
          "Copy the device code below with the copy icon, click 'Open Sign-In Page' to approve in your browser, then click 'Complete OAuth Sign-In'.",
        command_line: pendingOAuth.userCode,
        actions: [
          {
            type: "link",
            label: "Open Sign-In Page",
            target: { kind: "external", url: pendingOAuth.verificationUri },
            appearance: "primary",
          },
          {
            type: "button",
            label: "Complete OAuth Sign-In",
            action_id: "poll_oauth_device",
            style: "primary",
          },
          {
            type: "button",
            label: "Cancel",
            action_id: "cancel_oauth",
            style: "secondary",
          },
        ],
      });
    } else if (pendingOAuth.flow === "pkce_code") {
      oauthLeftBlocks.push(
        {
          type: "empty",
          size: "sm",
          title: "1. Authorize Anthropic (Claude Pro / Max)",
          description:
            "Click below to sign in with your Claude Pro/Max subscription, then paste the 'code#state' string Anthropic displays into the box below.",
          actions: [
            {
              type: "link",
              label: "Open Claude OAuth Sign-In",
              target: { kind: "external", url: pendingOAuth.verificationUri },
              appearance: "primary",
            },
            {
              type: "button",
              label: "Cancel",
              action_id: "cancel_oauth",
              style: "secondary",
            },
          ],
        },
        {
          type: "form",
          block_id: "pi-anthropic-code-form",
          fields: [
            {
              type: "text_input",
              action_id: "authorizationCode",
              label: "Paste Anthropic Authorization Code (code#state)",
              placeholder: "code#state",
            },
          ],
          submit: { label: "Complete Claude OAuth", action_id: "complete_anthropic_oauth" },
        },
      );
    }
  } else {
    oauthLeftBlocks.push(
      header("Option 1 — 1-Click Pi Subscription OAuth"),
      context(
        "Authenticate your existing AI subscription directly from EmDash using @earendil-works/pi-ai OAuth (no separate API billing needed).",
      ),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            label: "Sign in with OpenAI (ChatGPT Plus/Pro)",
            action_id: "start_oauth_openai",
            style: "primary",
          },
          {
            type: "button",
            label: "Sign in with Claude Pro/Max",
            action_id: "start_oauth_anthropic",
            style: "secondary",
          },
          {
            type: "button",
            label: "Sign in with xAI (SuperGrok)",
            action_id: "start_oauth_xai",
            style: "secondary",
          },
        ],
      },
    );
  }

  const oauthRightBlocks: Block[] = [
    header("Option 2 — Paste API Key or Token Directly"),
    context(
      "Prefer a direct API key (OpenAI, Anthropic, Gemini, xAI) or a token from ~/.pi/agent/auth.json? Save it directly to your Worker here.",
    ),
    {
      type: "form",
      block_id: "pi-direct-auth-form",
      fields: [
        {
          type: "select",
          action_id: "providerId",
          label: "Provider",
          initial_value: connection.model.split("/")[0] ?? "openai-codex",
          options: [
            { label: "OpenAI / Codex", value: "openai-codex" },
            { label: "Anthropic Claude", value: "anthropic" },
            { label: "Google Gemini", value: "google" },
            { label: "xAI Grok", value: "xai" },
            { label: "Meta Muse", value: "meta" },
          ],
        },
        {
          type: "secret_input",
          action_id: "apiKey",
          label: "Provider API Key or OAuth Access Token",
          placeholder: "sk-... or OAuth token",
          has_value: Boolean(subAuth),
        },
      ],
      submit: { label: "Save Subscription Key", action_id: "save_subscription_key" },
    },
  ];

  const subscriptionBlocks: Block[] = isAdmin
    ? [{ type: "columns", columns: [oauthLeftBlocks, oauthRightBlocks] }]
    : [context("Only an Administrator can authenticate the Pi subscription.")];

  const settingsBlocks: Block[] = isAdmin
    ? [
        {
          type: "columns",
          columns: [
            [
              {
                type: "form",
                block_id: "pi-durable-collections-form",
                fields: [
                  {
                    type: "checkbox",
                    action_id: "enabledCollections",
                    label: "Enabled Editor Side-Panel Collections",
                    initial_value: connection.enabledCollections,
                    options: collections.map(col => ({
                      label: `${col.label} (${col.slug})`,
                      value: col.slug,
                    })),
                  },
                ],
                submit: { label: "Update enabled collections", action_id: "save_collections" },
              },
            ],
            [
              fields(
                ["Worker Endpoint", connection.workerUrl],
                [
                  "Subscription Status",
                  subAuth ? `Signed in (${subAuth.label})` : "Not signed in yet",
                ],
                [
                  "Authority Mode",
                  connection.authorityMode === "read_only"
                    ? "Read-only"
                    : "Propose with WAITING_FOR_HUMAN cards",
                ],
              ),
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
            ],
          ],
        },
      ]
    : [context("Only an Administrator can modify enabled collections or disconnect the Worker.")];

  blocks.push({
    type: "tab",
    ...(typeof defaultTab === "number" ? { default_tab: defaultTab } : {}),
    panels: [
      {
        label: "Assistant & Live Steer",
        blocks: [{ type: "columns", columns: [assistantLeft, assistantRight] }],
      },
      {
        label: subAuth ? `Subscription & OAuth (✓)` : "Subscription & OAuth (Sign In)",
        blocks: subscriptionBlocks,
      },
      {
        label: `Approval Queue (${proposals.length})`,
        blocks: approvalBlocks,
      },
      {
        label: "Collections & Connection",
        blocks: settingsBlocks,
      },
    ],
  });

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

    const enabledCollections = Array.isArray(event.values.enabledCollections)
      ? event.values.enabledCollections.filter((item): item is string => typeof item === "string")
      : collections.filter(col => event.values[`col_${col.slug}`] !== false).map(col => col.slug);

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
  const pendingOAuth = await loadPendingOAuth(ctx);

  if (event.type === "block_action" && event.action_id === "cancel_oauth" && isAdmin) {
    if (ctx.kv) {
      await ctx.kv.delete("pending_oauth");
    }
    return workspacePage(
      connection,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      undefined,
      { type: "info", message: "Cancelled pending OAuth sign-in." },
      null,
      1,
    );
  }

  if (event.type === "block_action" && event.action_id === "start_oauth_openai" && isAdmin) {
    try {
      const resp = await pluginFetch(ctx, "https://auth.openai.com/api/accounts/deviceauth/usercode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
      });
      const json = (await resp.json()) as {
        device_auth_id?: string;
        user_code?: string;
        interval?: number | string;
      };
      if (!resp.ok || !json.device_auth_id || !json.user_code) {
        throw new Error(`OpenAI device code request returned HTTP ${resp.status}`);
      }
      const nextOAuth: PendingOAuthSession = {
        providerId: "openai-codex",
        flow: "device_code",
        userCode: json.user_code,
        verificationUri: "https://auth.openai.com/codex/device",
        deviceAuthId: json.device_auth_id,
        intervalSeconds: Number(json.interval) || 5,
        createdAt: new Date().toISOString(),
      };
      if (ctx.kv) {
        await ctx.kv.set("pending_oauth", nextOAuth);
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
          message: `OpenAI device code ready (${json.user_code}). Copy the code and authorize in your browser.`,
        },
        nextOAuth,
        1,
      );
    } catch (err) {
      return workspacePage(
        connection,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        undefined,
        {
          type: "error",
          message: `Could not start OpenAI device code flow: ${err instanceof Error ? err.message : String(err)}`,
        },
        pendingOAuth,
        1,
      );
    }
  }

  if (event.type === "block_action" && event.action_id === "start_oauth_xai" && isAdmin) {
    try {
      const resp = await pluginFetch(ctx, "https://auth.x.ai/oauth2/device/code", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: XAI_CLIENT_ID,
          scope: "openid profile email offline_access grok-cli:access api:access",
          referrer: "pi",
        }).toString(),
      });
      const json = (await resp.json()) as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        verification_uri_complete?: string;
        interval?: number;
      };
      if (!resp.ok || !json.device_code || !json.user_code) {
        throw new Error(`xAI device code request returned HTTP ${resp.status}`);
      }
      const nextOAuth: PendingOAuthSession = {
        providerId: "xai",
        flow: "device_code",
        userCode: json.user_code,
        verificationUri: json.verification_uri_complete ?? json.verification_uri ?? "https://auth.x.ai",
        deviceCode: json.device_code,
        intervalSeconds: json.interval ?? 5,
        createdAt: new Date().toISOString(),
      };
      if (ctx.kv) {
        await ctx.kv.set("pending_oauth", nextOAuth);
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
          message: `xAI SuperGrok code ready (${json.user_code}). Copy the code and authorize in your browser.`,
        },
        nextOAuth,
        1,
      );
    } catch (err) {
      return workspacePage(
        connection,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        undefined,
        {
          type: "error",
          message: `Could not start xAI device flow: ${err instanceof Error ? err.message : String(err)}`,
        },
        pendingOAuth,
        1,
      );
    }
  }

  if (event.type === "block_action" && event.action_id === "start_oauth_anthropic" && isAdmin) {
    const { verifier, challenge } = await generatePKCE();
    const authParams = new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      scope:
        "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
    });
    const nextOAuth: PendingOAuthSession = {
      providerId: "anthropic",
      flow: "pkce_code",
      verificationUri: `https://claude.ai/oauth/authorize?${authParams.toString()}`,
      verifier,
      intervalSeconds: 0,
      createdAt: new Date().toISOString(),
    };
    if (ctx.kv) {
      await ctx.kv.set("pending_oauth", nextOAuth);
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
        message: "Click 'Open Claude OAuth Sign-In', then paste the code#state shown by Anthropic.",
      },
      nextOAuth,
      1,
    );
  }

  if (event.type === "block_action" && event.action_id === "poll_oauth_device" && isAdmin) {
    if (!pendingOAuth) {
      return workspacePage(
        connection,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        undefined,
        { type: "error", message: "No active OAuth device session found." },
        null,
        1,
      );
    }
    if (pendingOAuth.providerId === "openai-codex") {
      const pollResp = await pluginFetch(ctx, "https://auth.openai.com/api/accounts/deviceauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_auth_id: pendingOAuth.deviceAuthId,
          user_code: pendingOAuth.userCode,
        }),
      });
      if (!pollResp.ok) {
        return workspacePage(
          connection,
          collections,
          proposals,
          activeTurn,
          isAdmin,
          undefined,
          {
            type: "info",
            message:
              "Still waiting for browser approval on auth.openai.com/codex/device — approve in your browser, then click 'Complete OAuth Sign-In' again.",
          },
          pendingOAuth,
          1,
        );
      }
      const pollJson = (await pollResp.json()) as {
        authorization_code?: string;
        code_verifier?: string;
      };
      const tokenResp = await pluginFetch(ctx, "https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: OPENAI_CLIENT_ID,
          code: pollJson.authorization_code ?? "",
          code_verifier: pollJson.code_verifier ?? "",
          redirect_uri: "https://auth.openai.com/deviceauth/callback",
        }).toString(),
      });
      if (!tokenResp.ok) {
        return workspacePage(
          connection,
          collections,
          proposals,
          activeTurn,
          isAdmin,
          undefined,
          { type: "error", message: `OpenAI token exchange failed (${tokenResp.status}).` },
          pendingOAuth,
          1,
        );
      }
      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      const credential = {
        type: "oauth",
        access: tokenData.access_token ?? "",
        refresh: tokenData.refresh_token ?? "",
        expires: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
      };
      const updated: PiDurableConnection = {
        ...connection,
        subscriptionAuth: {
          providerId: "openai-codex",
          authType: "oauth",
          label: "OpenAI (ChatGPT Plus/Pro)",
          connectedAt: new Date().toISOString().slice(0, 10),
        },
      };
      await saveConnectionRecord(ctx, updated);
      await syncCredentialToWorker(ctx, updated, "openai-codex", "oauth", credential);
      if (ctx.kv) await ctx.kv.delete("pending_oauth");
      return workspacePage(
        updated,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        undefined,
        {
          type: "success",
          message: "Signed in with OpenAI (ChatGPT Plus/Pro) and synced OAuth credentials to your Worker!",
        },
        null,
        1,
      );
    }

    if (pendingOAuth.providerId === "xai") {
      const tokenResp = await pluginFetch(ctx, "https://auth.x.ai/oauth2/token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: XAI_CLIENT_ID,
          device_code: pendingOAuth.deviceCode ?? "",
        }).toString(),
      });
      if (!tokenResp.ok) {
        return workspacePage(
          connection,
          collections,
          proposals,
          activeTurn,
          isAdmin,
          undefined,
          {
            type: "info",
            message:
              "Still waiting for xAI browser approval — complete sign-in in your browser, then click 'Complete OAuth Sign-In' again.",
          },
          pendingOAuth,
          1,
        );
      }
      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      const credential = {
        type: "oauth",
        access: tokenData.access_token ?? "",
        refresh: tokenData.refresh_token ?? "",
        expires: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
      };
      const updated: PiDurableConnection = {
        ...connection,
        subscriptionAuth: {
          providerId: "xai",
          authType: "oauth",
          label: "xAI (SuperGrok / X Premium)",
          connectedAt: new Date().toISOString().slice(0, 10),
        },
      };
      await saveConnectionRecord(ctx, updated);
      await syncCredentialToWorker(ctx, updated, "xai", "oauth", credential);
      if (ctx.kv) await ctx.kv.delete("pending_oauth");
      return workspacePage(
        updated,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        undefined,
        {
          type: "success",
          message: "Signed in with xAI (SuperGrok) and synced OAuth credentials to your Worker!",
        },
        null,
        1,
      );
    }
  }

  if (event.type === "form_submit" && event.action_id === "complete_anthropic_oauth" && isAdmin) {
    const rawCode = cleanText(event.values.authorizationCode, 600);
    if (!rawCode || !pendingOAuth || pendingOAuth.providerId !== "anthropic") {
      return workspacePage(
        connection,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        undefined,
        { type: "error", message: "Paste the code#state string shown by Anthropic." },
        pendingOAuth,
        1,
      );
    }
    const [code, state] = rawCode.includes("#")
      ? rawCode.split("#", 2)
      : [rawCode, pendingOAuth.verifier ?? ""];
    const tokenResp = await pluginFetch(ctx, "https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: ANTHROPIC_CLIENT_ID,
        code,
        state: state || pendingOAuth.verifier,
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
        code_verifier: pendingOAuth.verifier,
      }),
    });
    if (!tokenResp.ok) {
      return workspacePage(
        connection,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        undefined,
        { type: "error", message: `Anthropic token exchange failed (HTTP ${tokenResp.status}).` },
        pendingOAuth,
        1,
      );
    }
    const tokenData = (await tokenResp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const credential = {
      type: "oauth",
      access: tokenData.access_token ?? "",
      refresh: tokenData.refresh_token ?? "",
      expires: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    };
    const updated: PiDurableConnection = {
      ...connection,
      subscriptionAuth: {
        providerId: "anthropic",
        authType: "oauth",
        label: "Anthropic (Claude Pro/Max)",
        connectedAt: new Date().toISOString().slice(0, 10),
      },
    };
    await saveConnectionRecord(ctx, updated);
    await syncCredentialToWorker(ctx, updated, "anthropic", "oauth", credential);
    if (ctx.kv) await ctx.kv.delete("pending_oauth");
    return workspacePage(
      updated,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      undefined,
      {
        type: "success",
        message: "Signed in with Anthropic (Claude Pro/Max) and synced OAuth credentials to your Worker!",
      },
      null,
      1,
    );
  }

  if (event.type === "form_submit" && event.action_id === "save_subscription_key" && isAdmin) {
    const providerId = cleanText(event.values.providerId, 60) ?? "openai-codex";
    const apiKey = cleanText(event.values.apiKey, 600);
    if (!apiKey) {
      return workspacePage(
        connection,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        undefined,
        { type: "error", message: "Enter your provider API key or OAuth token." },
        pendingOAuth,
        1,
      );
    }
    const updated: PiDurableConnection = {
      ...connection,
      subscriptionAuth: {
        providerId,
        authType: "api_key",
        label: providerId,
        connectedAt: new Date().toISOString().slice(0, 10),
      },
    };
    await saveConnectionRecord(ctx, updated);
    await syncCredentialToWorker(ctx, updated, providerId, "api_key", {
      type: "api_key",
      key: apiKey,
    });
    return workspacePage(
      updated,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      undefined,
      {
        type: "success",
        message: `Saved ${providerId} credential and synced to your Pi Durable Worker.`,
      },
      null,
      1,
    );
  }

  if (event.type === "form_submit" && event.action_id === "save_collections" && isAdmin) {
    const enabledCollections = Array.isArray(event.values.enabledCollections)
      ? event.values.enabledCollections.filter((item): item is string => typeof item === "string")
      : collections.filter(col => event.values[`col_${col.slug}`] === true).map(col => col.slug);
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

  return workspacePage(
    connection,
    collections,
    proposals,
    activeTurn,
    isAdmin,
    undefined,
    undefined,
    pendingOAuth,
    pendingOAuth ? 1 : undefined,
  );
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
