# PCRP Bylaws Workbench: website edition

This is the Bylaws Workbench with two additions:

- **Comments on every repair.** Each repair card has an **Add a comment** button and shows its latest comments. Only the comment and a name are required. PCOs can add their precinct, anyone can add an email that only the moderator sees, and anyone can mark Support or Oppose. Returning commenters see their details on one line instead of retyping them.
- **Comments show right away, with an automatic hold.** A comment that looks like spam or abuse waits for your approval instead (see "Moderation").
- **Rate limits you set yourself.** Limits apply per person and to everyone together. You change them on the admin page, with no redeploy.

## What's in the folder

| Path | What it is |
| --- | --- |
| `site/index.html` | The Workbench page. It's generated, so don't edit it by hand (see "Changing the page"). |
| `site/admin/index.html` | The admin page: approve or hide posts, change limits, download everything. |
| `netlify/functions/` | Three small functions: `submit` (new posts), `feed` (the public list), `admin`. |
| `netlify/lib/core.mjs` | All the rules: validation, rate limits, moderation, privacy. |
| `dev/` | A local preview server with in-memory storage. |
| `test/` | Automated tests (`npm test`). |

## Set it up on Netlify (about 15 minutes)

1. **Put the folder in a Git repository** (GitHub is easiest) and import that repository as a new project in Netlify. Netlify reads `netlify.toml`, so you don't need to change any build settings.
   - Alternatively, use the Netlify CLI: run `npm install`, then `npx netlify deploy --prod` from this folder.
   - Don't use drag-and-drop upload. It doesn't build the functions, so comments wouldn't work.
2. **Set environment variables** in the project's settings:
   - `ADMIN_KEY` (required): a long random password, at least 12 characters. It opens the admin page. Keep it private, but leave **Contains secret values** unticked: Netlify never shows a secret value again, and secret values have been reported missing inside Functions.
   - `IP_SALT` (recommended): any long random string. It scrambles IP addresses before they're stored.
   - Optional starting values, all changeable later on the admin page: `RL_IP_PER_HOUR`, `RL_IP_PER_DAY`, `RL_ALL_PER_HOUR`, `RL_ALL_PER_DAY`, `MODERATION` (`hold` or `publish`), `MAX_COMMENT_CHARS`.
3. **Redeploy** so the functions pick up the variables. Then open `https://your-site.netlify.app/admin/` and sign in with `ADMIN_KEY`.
4. **Post a test comment** on the public page and check that it appears. Then post one with a link in it and check that it waits on the admin page. Approve or delete it there.

Storage uses Netlify Blobs, which is built into Netlify. There's no database to create.

## Rate limits

Every limit can be changed on the admin page under **Settings**. Changes take effect within a minute, with no redeploy.

| Setting | Default | What it means |
| --- | --- | --- |
| Per person, per hour | 6 | Posts accepted from one internet connection in any 60 minutes |
| Per person, per day | 20 | ... in any 24 hours |
| Everyone together, per hour | 100 | Posts accepted from all connections combined in any 60 minutes |
| Everyone together, per day | 500 | ... in any 24 hours |
| Longest comment | 2,000 characters | |

Things to know:

- **"Per person" means per internet connection (IP address).** Everyone on the same Wi-Fi, like a meeting room or a church hall, shares one connection, and so do many phones on the same carrier. Raise the per-person limits before you ask a room of people to comment.
- **Limits count accepted posts only.** Rejected attempts don't use up anyone's allowance, and a person blocked by the overall limit gets their slot back.
- **Simultaneous posts can't slip past the limits.** In testing, 40 posts sent at the same moment against a limit of 10 let exactly 10 through, every time.
- **There's a second, fixed layer in front of yours.** Netlify's edge limit allows 30 requests a minute per connection to `submit` and 60 a minute to `admin`. It stops floods before they reach your limits. Change it only in the function files, which takes a redeploy.
- The admin sign-in locks a connection out for an hour after 10 wrong keys.

## Moderation

- **Show right away** (the default): comments appear at once, except ones the automatic check holds. Those wait under **Waiting** on the admin page, marked with the reason. The person is told a moderator will read the comment first.
- The automatic check holds a comment that has a possible threat of violence, strong language or a slur, an email address, phone number or street address, a link, code or HTML, mostly capital letters, a long run of one character, or mostly another alphabet. It never deletes or rejects anything for these reasons. A false alarm only means you approve it. Figures of speech about proposals ("kill this amendment," "shot down") pass. It won't catch a politely worded personal attack, so hide anything like that yourself.
- **Wait for my approval**: nothing appears until you approve it on the admin page.
- **Accept new comments: No** stops new comments and leaves existing ones up.
- **Hide** takes a post off the public page and keeps it. **Delete** removes it for good.
- The public list updates within about a minute of any change, because Netlify caches it for up to a minute.

## Privacy

- Emails are never shown publicly. Only the admin page and the CSV download include them.
- Names and precincts appear unless the person unticks "Show my name and precinct with my comment." Then the page shows "Name withheld," "PCO" if they gave a precinct, and the legislative district taken from the precinct number.
- IP addresses are never stored. Each one is scrambled with `IP_SALT` into a code that can't be turned back into an address. The admin page uses that code to show how many posts came from the same connection.
- Precincts are whatever people type, and a precinct is what marks a comment "PCO." To confirm someone is a PCO, check their name, precinct and email (if they gave one) against the PCO list.
- Comments are always shown as plain text, so code typed into a comment can't run, and there's no database query language to inject into. The CSV defuses spreadsheet formulas, and a Content-Security-Policy header limits what the pages may load or send.
- The CSV includes emails, so keep it private. It defuses spreadsheet formulas in posted text.

## Costs on Netlify's free plan

The free plan gives 300 credits a month, and each production deploy costs 15. Posting comments doesn't deploy anything, so it doesn't use deploy credits. The functions and storage use very little.

Deploys happen only when you change the page itself. If credits ever run out, Netlify pauses the site until the next month, so don't deploy dozens of small edits. Deploy Previews, the preview links Netlify builds for pull requests, are free.

## Try it on your own computer

You need Node.js 22.12 or newer.

```
npm run dev        # http://localhost:8888 (admin key: local-admin-key)
npm test           # 10 tests: limits, moderation, automatic hold, privacy, validation, admin lockout
```

The local server keeps posts in memory, so they vanish when you stop it. It doesn't need `npm install`.

## Changing the page

`site/index.html` and `netlify/lib/ids.mjs` are generated from the Workbench source, the same source as the claude.ai version. Ask Claude to rebuild them, then redeploy. Don't edit the generated files by hand, or the next rebuild will overwrite your changes.

## After you deploy

The member emails and the handout still link to the claude.ai Workbench. Once you have this site's address (a short custom domain is best for printed handouts), swap it in everywhere.
