/**
 * Companion Cloudflare Worker + SQLite Durable Object (`EmDashPiDurableAgent`)
 * for `@dinkuskit/pi-durable`.
 *
 * Deployed alongside an EmDash CMS site via the 1-Click "Deploy to Cloudflare"
 * button on the Pi Assistant admin page.
 */
export interface Env {
  PI_AGENT: DurableObjectNamespace;
  PI_WORKER_TOKEN?: string;
}

export class EmDashPiDurableAgent {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        steer_note TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/turn") {
      const body = (await request.json()) as {
        turnId?: string;
        model?: string;
        prompt?: string;
        whenBusy?: "steer";
      };
      const turnId = body.turnId ?? `turn_${Date.now()}`;
      const model = body.model ?? "openai-codex/gpt-6.1-sol:high";
      const prompt = body.prompt ?? "";
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO turns (turn_id, model, prompt, status, created_at) VALUES (?, ?, ?, 'running', ?)`,
        turnId,
        model,
        prompt,
        new Date().toISOString(),
      );
      return Response.json({
        ok: true,
        turnId,
        model,
        whenBusy: body.whenBusy ?? "steer",
        status: "running",
      });
    }
    return Response.json({ ok: true, service: "dinkus-pi-durable-worker" });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("authorization");
    if (env.PI_WORKER_TOKEN && auth !== `Bearer ${env.PI_WORKER_TOKEN}`) {
      return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
    const id = env.PI_AGENT.idFromName("default");
    const stub = env.PI_AGENT.get(id);
    return stub.fetch(request);
  },
};
