import { getStore } from "@netlify/blobs";
import { handleFeed, netlifyStores } from "../lib/core.mjs";

export default async (req, context) => handleFeed(req, context, { stores: netlifyStores(getStore), env: process.env });

export const config = { path: "/api/feed", method: ["GET", "HEAD"] };
