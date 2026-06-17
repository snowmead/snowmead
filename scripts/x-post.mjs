// Announces blog posts on X (Twitter) from CI. Three modes:
//
//   --seed      Record every current post in the ledger WITHOUT posting. Run once
//               at setup so pre-existing posts are never retro-announced.
//   --preview   Print a Markdown summary of what *would* be posted. No API calls,
//               no writes. The PR workflow pipes this into a sticky comment.
//   --publish   Post to X and update the ledger. Used on merge to main.
//
// State lives in .x-posts.json (committed): one entry per post slug, holding the
// announcement tweet id (so "Updated" replies can thread under it) and the last
// applied tweetUpdate key (so the same update isn't replied twice).
//
// Frontmatter controls (all optional; see src/content.config.ts):
//   tweet: false        -> never announce this post
//   tweetText: "..."    -> override the auto-composed announcement text
//   tweetUpdate: "..."  -> when set/changed, thread an "Updated" reply (opt-in)
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_DIR = join(ROOT, 'src/content/blog');
const LEDGER = join(ROOT, '.x-posts.json');

// Mirrors src/consts.ts (AUTHOR.handle) and astro.config.mjs (site).
const SITE = 'https://snowmead.com';
const HANDLE = 'snowmead';
const URL_WEIGHT = 23; // X counts every URL as 23 chars regardless of length.
const MAX = 280;

const postUrl = (slug) => `${SITE}/blog/${slug}/`;
const statusUrl = (id) => `https://x.com/${HANDLE}/status/${id}`;

// Minimal frontmatter reader: scalar `key: value` lines with optional quotes.
// Good enough for the fields we touch; array/multiline values are ignored.
function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    const q = v.match(/^'(.*)'$/) || v.match(/^"(.*)"$/);
    if (q) v = q[1];
    out[mm[1]] = v;
  }
  return out;
}

// X's weighted length: every URL counts as 23 chars regardless of its real
// length. Approximate emoji/CJK as 1 code point (X weights some as 2 — close
// enough to flag genuine overflows).
function xLen(text) {
  let n = [...text].length;
  for (const u of text.match(/https?:\/\/\S+/g) || []) n += URL_WEIGHT - [...u].length;
  return n;
}

function truncate(s, room) {
  if (s.length <= room) return s;
  return s.slice(0, room - 1).replace(/\s+\S*$/, '').trimEnd() + '…';
}

// New-post announcement: title, then description if it fits, then the link.
function composeNew(fm, slug) {
  if (fm.tweetText) return fm.tweetText.trim();
  const url = postUrl(slug);
  const title = (fm.title || slug).trim();
  const room = MAX - title.length - 2 /* \n\n */ - URL_WEIGHT - 2 /* desc's \n\n */;
  if (fm.description && room >= 30) {
    return `${title}\n\n${truncate(fm.description.trim(), room)}\n\n${url}`;
  }
  return `${title}\n\n${url}`;
}

// "Updated" reply: the tweetUpdate note (or a default), then the link.
function composeUpdate(fm, slug) {
  const url = postUrl(slug);
  const note =
    fm.tweetUpdate && fm.tweetUpdate !== 'true'
      ? fm.tweetUpdate.trim()
      : 'Updated this post.';
  const room = MAX - 2 /* "📝 " emoji+space, weighted */ - 2 - URL_WEIGHT;
  return `📝 ${truncate(note, room)}\n\n${url}`;
}

function readPosts() {
  return readdirSync(BLOG_DIR)
    .filter((f) => /\.(md|mdx)$/.test(f))
    .map((f) => ({
      slug: f.replace(/\.(md|mdx)$/, ''),
      fm: parseFrontmatter(readFileSync(join(BLOG_DIR, f), 'utf8')),
    }))
    .filter(({ fm }) => fm.draft !== 'true' && fm.tweet !== 'false');
}

const readLedger = () =>
  existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
const writeLedger = (l) =>
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n');

// Decide what to do for the current posts + ledger state.
function plan(posts, ledger) {
  const actions = [];
  for (const { slug, fm } of posts) {
    const entry = ledger[slug];
    if (!entry) {
      actions.push({ type: 'new', slug, fm, text: composeNew(fm, slug) });
    } else if (
      entry.tweetId &&
      fm.tweetUpdate &&
      fm.tweetUpdate !== (entry.lastUpdateKey ?? null)
    ) {
      actions.push({
        type: 'update',
        slug,
        fm,
        text: composeUpdate(fm, slug),
        replyTo: entry.tweetId,
        updateKey: fm.tweetUpdate,
      });
    }
  }
  return actions;
}

function renderPreview(actions) {
  const lines = ['<!-- x-autopost-preview -->', '### 🐦 X auto-post preview', ''];
  if (actions.length === 0) {
    lines.push(
      "This PR won't post anything to X (no new posts, and no `tweetUpdate` set on an existing one).",
    );
    return lines.join('\n');
  }
  lines.push(`On merge to \`main\`, this will post to [@${HANDLE}](https://x.com/${HANDLE}):`, '');
  for (const a of actions) {
    const heading =
      a.type === 'new'
        ? `**New post → new tweet** (\`${a.slug}\`)`
        : `**Edit → threaded "Updated" reply** (\`${a.slug}\`)`;
    const n = xLen(a.text);
    const meta =
      n > MAX
        ? `*⚠️ ${n}/${MAX} chars — too long; trim \`tweetText\`/\`tweetUpdate\`.*`
        : `*${n}/${MAX} chars · the link unfurls into the OG card.*`;
    lines.push(heading, '', '```text', a.text, '```', meta, '');
  }
  lines.push('---', '_Tweak copy with `tweetText:` / `tweetUpdate:` in frontmatter, or set `tweet: false` to skip._');
  return lines.join('\n');
}

async function publish(actions, ledger, posts) {
  if (actions.length === 0) {
    console.log('Nothing to post.');
    return;
  }
  const keys = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing X credentials: ${missing.join(', ')}`);
    process.exit(1);
  }
  const { TwitterApi } = await import('twitter-api-v2');
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
  const fmFor = (slug) => posts.find((p) => p.slug === slug)?.fm ?? {};

  for (const a of actions) {
    if (a.type === 'new') {
      const { data } = await client.v2.tweet(a.text);
      ledger[a.slug] = {
        tweetId: data.id,
        url: statusUrl(data.id),
        lastUpdateKey: fmFor(a.slug).tweetUpdate ?? null,
      };
      console.log(`Posted ${a.slug}: ${statusUrl(data.id)}`);
    } else {
      const { data } = await client.v2.tweet(a.text, {
        reply: { in_reply_to_tweet_id: a.replyTo },
      });
      ledger[a.slug].lastUpdateKey = a.updateKey;
      (ledger[a.slug].updates ??= []).push(data.id);
      console.log(`Replied (update) on ${a.slug}: ${statusUrl(data.id)}`);
    }
    writeLedger(ledger); // persist incrementally so a mid-run failure can't double-post
  }
}

async function main() {
  const mode = process.argv[2];
  const posts = readPosts();
  const ledger = readLedger();

  if (mode === '--seed') {
    let added = 0;
    for (const { slug, fm } of posts) {
      if (!ledger[slug]) {
        ledger[slug] = { tweetId: null, seeded: true, lastUpdateKey: fm.tweetUpdate ?? null };
        added++;
      }
    }
    writeLedger(ledger);
    console.log(`Seeded ${added} existing post(s); they won't be auto-announced.`);
    return;
  }

  const actions = plan(posts, ledger);

  if (mode === '--preview') {
    console.log(renderPreview(actions));
    return;
  }
  if (mode === '--publish') {
    await publish(actions, ledger, posts);
    return;
  }
  console.error('Usage: x-post.mjs --seed | --preview | --publish');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
