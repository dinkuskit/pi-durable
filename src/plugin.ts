import type { SandboxedPlugin } from "emdash/plugin";
import { piDurableAdmin, piDurableEditorPanel } from "./admin.js";

/**
 * Standalone Pi Durable Registry plugin for any EmDash CMS site: bolts a
 * companion Cloudflare Worker + Durable Object (@earendil-works/pi-durable)
 * next to the site with a 1-click Cloudflare deploy button, BYO Pi model
 * subscriptions, mid-task steering, and configurable content editor panels.
 */
const plugin: SandboxedPlugin = {
  routes: {
    admin: {
      public: false,
      permission: "content:edit_any",
      methods: ["POST"],
      handler: piDurableAdmin,
    },
    "editor/assistant": {
      public: false,
      permission: "content:edit_any",
      methods: ["POST"],
      handler: piDurableEditorPanel,
    },
  },
};

export default plugin;
