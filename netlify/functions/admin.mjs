import { getStore } from "@netlify/blobs";
import { handleAdmin, netlifyStores } from "../lib/core.mjs";

export default async (req, context) => handleAdmin(req, context, { stores: netlifyStores(getStore), env: process.env });

export const config = {
  path: "/api/admin",
  method: "POST",
  // Backstop against key guessing, on top of the 10-wrong-keys-an-hour lockout in core.mjs.
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] }
};
