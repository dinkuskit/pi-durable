import type { SandboxedPlugin } from "emdash/plugin";
import { piDurableAdmin } from "./admin.js";

/**
 * DinkusKit Pi Durable for the EmDash admin: bolts a serverless Pi Durable
 * agent (@earendil-works/pi-durable + @mariozechner/pi-agent-core on Cloudflare
 * Durable Objects) next to an EmDash CMS site with BYO Pi subscriptions,
 * read-only default authority, and WAITING_FOR_HUMAN Block Kit approval cards.
 */
const plugin: SandboxedPlugin = {
  routes: {
    admin: {
      public: false,
      permission: "content:edit_any",
      methods: ["POST"],
      handler: piDurableAdmin,
    },
  },
};

export default plugin;
