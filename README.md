# PCRP Bylaws Workbench: website edition

This is the Bylaws Workbench with these additions:

- **An access code.** The front page doesn't show the plan. It says the plan is being worked on for submittal at the first business meeting of the Central Committee in the new term, and asks for the access code. Anyone without the code can send a request (name, email, and optionally role, precinct and a note), which waits on the admin page. The plan itself is served by a function only to people who have entered the code, and so are its comments. The code is set on the admin page, and changing it signs everyone out.
- **Comments on every repair.** Each repair card has an **Add a comment** button and shows its comments. Only the comment and a name are required. Everything else is one tap or optional: a role (PCO, Precinct Captain, party member or guest), a view (Support, Support with changes, Oppose or Question), a precinct, and an email only the moderator sees.
- **Details once.** People can tell the page who they are with **Join the discussion** in the Comments panel, or with their first comment. The device remembers it, so every later comment is just the text. **Change** edits the details and **Not you?** clears them, for shared computers.
- **Finding the discussion.** A **Comments** button at the bottom of the screen opens a panel with four views: Latest, Most discussed, Questions (waiting and answered) and People. Tapping any name shows everything that person wrote, and **Go to this comment** jumps to it. Card and group headings show their comment counts. Comments load once when the page opens. Nothing checks again by itself; **Check for new comments** in the panel does it on request.
- **Your replies.** On the admin page you can answer any comment and mark it Answered, Changed in the revision, Considered, kept as is, or Noted. The reply shows under the comment, signed with the name you choose.
- **Revisions keep their comments.** Comments belong to a repair, not to its wording. When a repair is revised, its card says what changed and can show the earlier version, and comments written before the change are marked "On the earlier version."
- **Comments show right away, with an automatic hold.** A comment that looks like spam or abuse waits for your approval instead (see "Moderation").
- **Rate limits you set yourself.** Limits apply per person and to everyone together. You change them on the admin page, with no redeploy.

## What's in the folder

| Path | What it is |
| --- | --- |
| `site/index.html` | The front page: enter the access code, or ask for it. |
| `site/robots.txt` | Keeps search engines out. |
| `site/admin/index.html` | The admin page: the access code and requests for it, approve or hide posts, change limits, download everything. |
| `netlify/lib/page.mjs` | The Workbench page itself. It's generated, so don't edit it by hand (see "Changing the page"). |
| `netlify/functions/` | Five small functions: `plan` (the page, for people with the code), `access` (the code and requests), `submit` (new comments), `feed` (the list of comments), `admin`. |
| `netlify/lib/core.mjs` | All the rules: the access code, validation, rate limits, moderation, privacy. |
| `dev/` | A local preview server with in-memory storage. |
| `test/` | Automated tests (`npm test`). |

## Set it up on Netlify (about 15 minutes)

1. **Put the folder in a Git repository** (GitHub is easiest) and import that repository as a new project in Netlify. Netlify reads `netlify.toml`, so you don't need to change any build settings.
   - Alternatively, use the Netlify CLI: run `npm install`, then `npx netlify deploy --prod` from this folder.
   - Don't use drag-and-drop upload. It doesn't build the functions, so comments wouldn't work.
2. **Set environment variables** in the project's settings:
   - `ADMIN_KEY` (required): a long random password, at least 12 characters. It opens the admin page. Keep it private, but leave **Contains secret values** unticked: Netlify never shows a secret value again, and secret values have been reported missing inside Functions.
   - `IP_SALT` (recommended): any long random string. It scrambles IP addresses before they're stored.
   - `ACCESS_CODE` (optional): a starting access code. You can also set or change the code on the admin page, which wins over this.
   - Optional starting values, all changeable later on the admin page: `RL_IP_PER_HOUR`, `RL_IP_PER_DAY`, `RL_ALL_PER_HOUR`, `RL_ALL_PER_DAY`, `MODERATION` (`hold` or `publish`), `MAX_COMMENT_CHARS`.
3. **Redeploy** so the functions pick up the variables. Then open `https://your-site.netlify.app/admin/` and sign in with `ADMIN_KEY`.
4. **Set the access code** under **Access** on the admin page. Until there's a code, no one can open the plan.
5. **Open the front page, enter the code, and post a test comment.** Check that it appears. Then post one with a link in it and check that it waits on the admin page. Approve or delete it there. Try **Reply** on a comment and check the reply shows when you reload the plan.

Storage uses Netlify Blobs, which is built into Netlify. There's no database to create.

## Rate limits

Every limit can be changed on the admin page under **Settings**. Changes take effect right away, with no redeploy.

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
- Approvals, hides and replies show the next time someone opens the page, or taps **Check for new comments**.
- Commenters can't edit or delete their own comments, because the site has no accounts to prove who wrote what. If someone wants a comment changed or removed, they can ask you, or post a follow-up.

## The access code

- The plan opens only with the code. People type it on the front page; capital letters, spaces and punctuation don't matter, so "Repair 2027" and "repair-2027" both work. The browser remembers it for 90 days.
- A link to a part of the plan still works: someone without the code lands on the front page, and after the code, on that part.
- **Changing the code** signs everyone out until they enter the new one. **Leaving it blank** closes the plan to everyone. Either way, comments and replies are kept.
- **Requests for the code** wait under **Access** on the admin page. **Email the code** opens your email app with a message ready to send. Then mark the request done.
- Guessing is slowed down: 10 wrong codes in an hour lock that connection out for an hour, and one connection can send 5 requests a day.
- The browser keeps a scrambled token, never the code itself. The page, the comments, and posting all check it. Netlify's CDN never stores a copy of the plan or the comments.
- Anyone with the code can pass it on. Change it if it gets around further than you want.

## Replies

- **Needs a reply** on the admin page lists live questions and "Support with changes" comments you haven't answered yet.
- **Reply** opens a short form. Mark the comment Answered, Changed in the revision, Considered, kept as is, or Noted, write a reply, or both. **Edit reply** changes it and **Remove reply** takes it down.
- The reply shows under the comment as "Reply from the author," or whatever name you set in **Settings** under **Sign replies as**. A reply on a comment that isn't live shows once the comment is live.
- On the public page, answered comments move to the top of their repair, so the next reader sees the answer first. Answered questions drop out of the "waiting for an answer" count.

## Revising a repair

Comments are stored against each repair's permanent ID, not its number or wording, so rewriting a repair never loses them. Every comment is stamped with the version of the repair it was written on. When a repair is revised, its card shows a "Revised" note listing what changed, and **See the earlier version** shows the earlier summary and exact wording. Comments from before the revision are marked "On the earlier version," and the admin page marks them too.

Repairs 41 to 44 were revised on October 12, 2026, after members' comments. To revise a repair again, ask Claude to rebuild the page with the change. The rebuild keeps the earlier version for the "See the earlier version" view.

## Privacy

- The plan, its comments and the comment form are only for people with the access code. The whole site carries "noindex" and `robots.txt` turns crawlers away.
- Emails are never shown on the page. Only the admin page and the CSV download include them. Emails in requests for the code are only on the admin page.
- Names and precincts appear unless the person unticks "Show my name and precinct with my comments." Then the page shows "Name withheld," the role they chose, if any, and the legislative district taken from the precinct number.
- IP addresses are never stored. Each one is scrambled with `IP_SALT` into a code that can't be turned back into an address. The admin page uses that code to show how many posts came from the same connection.
- Roles and precincts are whatever people choose and type. A precinct alone doesn't make a comment "PCO," since Precinct Captains have precincts too. To confirm someone is a PCO, check their name, precinct and email (if they gave one) against the PCO list.
- The details people enter once are kept only in their own browser, on that device. **Not you?** clears them.
- Comments are always shown as plain text, so code typed into a comment can't run, and there's no database query language to inject into. The CSV defuses spreadsheet formulas, and a Content-Security-Policy header limits what the pages may load or send.
- The CSV includes emails, so keep it private. It defuses spreadsheet formulas in posted text.

## Costs on Netlify's free plan

The free plan gives 300 credits a month, and each production deploy costs 15. Posting comments doesn't deploy anything, so it doesn't use deploy credits. The functions and storage use very little.

Deploys happen only when you change the page itself. If credits ever run out, Netlify pauses the site until the next month, so don't deploy dozens of small edits. Deploy Previews, the preview links Netlify builds for pull requests, are free.

## Try it on your own computer

You need Node.js 22.12 or newer.

```
npm run dev        # http://localhost:8888 (access code: local code; admin key: local-admin-key)
npm test           # 16 tests: limits, moderation, automatic hold, privacy, validation, admin lockout, version stamps, replies, the access code, requests
```

The local server keeps posts in memory, so they vanish when you stop it. It doesn't need `npm install`.

## Changing the page

`netlify/lib/page.mjs`, `site/index.html` and `netlify/lib/ids.mjs` are generated from the Workbench source, the same source as the claude.ai version. Ask Claude to rebuild them, then redeploy. Don't edit the generated files by hand, or the next rebuild will overwrite your changes.

## After you deploy

The member emails and the handout still link to the claude.ai Workbench. Once you have this site's address (a short custom domain is best for printed handouts), swap it in everywhere.
