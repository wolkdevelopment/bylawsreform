import { getStore } from "@netlify/blobs";
import { handleSubmit, netlifyStores } from "../lib/core.mjs";

export default async (req, context) => handleSubmit(req, context, { stores: netlifyStores(getStore), env: process.env });

export const config = {
  path: "/api/submit",
  method: "POST",
  // Netlify's own edge limit: a fixed backstop in front of the settable limits in core.mjs.
  // It caps raw requests (including rejected ones) at 30 a minute per IP address.
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] }
};
