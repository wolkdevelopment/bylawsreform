import { getStore } from "@netlify/blobs";
import { handleAccess, netlifyStores } from "../lib/core.mjs";

export default async (req, context) => handleAccess(req, context, { stores: netlifyStores(getStore), env: process.env });

export const config = {
  path: "/api/access",
  method: ["GET", "POST"],
  // Backstop against code guessing, on top of the 10-wrong-codes-an-hour lockout in core.mjs.
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] }
};
