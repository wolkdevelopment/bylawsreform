import { getStore } from "@netlify/blobs";
import { handlePlan, netlifyStores } from "../lib/core.mjs";
import { PLAN_HTML } from "../lib/page.mjs";

// The plan page, served only to people who entered the access code. Everyone else goes to the front page.
export default async (req, context) => handlePlan(req, context, { stores: netlifyStores(getStore), env: process.env }, PLAN_HTML);

export const config = { path: ["/plan", "/plan/"], method: ["GET", "HEAD"] };
