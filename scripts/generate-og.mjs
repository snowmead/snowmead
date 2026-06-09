// Generates the favicon raster, apple-touch icon, and Open Graph social cards
// (a default + one per blog post, with the post title baked in) using sharp.
// Run via `bun scripts/generate-og.mjs`; wired into the build script so the
// per-post cards stay in sync with the content collection.
import sharp from 'sharp';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_DIR = join(ROOT, 'src/content/blog');
const PUBLIC = join(ROOT, 'public');
const OG_DIR = join(PUBLIC, 'og');

// Brand + palette (mirrors src/consts.ts and the site's zinc/sky theme).
const BRAND = 'Michael Assaf';
const DOMAIN = 'snowmead.com';
const TAGLINE = 'Software, systems, and the occasional rabbit hole.';
const BG = '#0a0a0a'; // zinc-950
const FG = '#fafafa'; // zinc-50
const MUTED = '#a1a1aa'; // zinc-400
const SKY = '#38bdf8'; // sky-400
const FONT = 'Helvetica, Arial, sans-serif';
const W = 1200;
const H = 630;

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Crude word wrap by estimated glyph advance (good enough for headline text).
function wrap(text, fontSize, maxWidth, maxLines) {
  const charW = fontSize * 0.55;
  const maxChars = Math.floor(maxWidth / charW);
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    const used = lines.join(' ').length;
    if (used < text.length) lines[maxLines - 1] = `${lines[maxLines - 1]}…`;
  }
  return lines;
}

// The "s" brand tile as a standalone icon, parametrized by size + corner radius.
function tile(size, rx) {
  const fs = Math.round(size * 0.69);
  const baseline = Math.round(size * 0.72);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${rx}" fill="${BG}"/><text x="${size / 2}" y="${baseline}" font-family="${FONT}" font-size="${fs}" font-weight="700" fill="${FG}" text-anchor="middle">s</text></svg>`;
}

// Brand row used at the top of every card: the tile + the author name.
function brandRow() {
  return `<g transform="translate(80,72)">
    <rect width="84" height="84" rx="20" fill="${BG}" stroke="${SKY}" stroke-width="2"/>
    <text x="42" y="60" font-family="${FONT}" font-size="58" font-weight="700" fill="${FG}" text-anchor="middle">s</text>
    <text x="108" y="56" font-family="${FONT}" font-size="34" font-weight="600" fill="${MUTED}">${esc(BRAND)}</text>
  </g>`;
}

function cardShell(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="0" y="${H - 8}" width="${W}" height="8" fill="${SKY}"/>
  ${brandRow()}
  ${inner}
  <text x="80" y="556" font-family="${FONT}" font-size="30" font-weight="600" fill="${SKY}">${esc(DOMAIN)}</text>
</svg>`;
}

function postCard(title) {
  const lines = wrap(title, 66, 1040, 3);
  const startY = 300 - (lines.length - 1) * 40;
  const tspans = lines
    .map(
      (l, i) =>
        `<text x="80" y="${startY + i * 82}" font-family="${FONT}" font-size="66" font-weight="700" fill="${FG}">${esc(l)}</text>`,
    )
    .join('\n  ');
  return cardShell(tspans);
}

function defaultCard() {
  const tagLines = wrap(TAGLINE, 34, 1000, 2);
  const tag = tagLines
    .map(
      (l, i) =>
        `<text x="80" y="${392 + i * 46}" font-family="${FONT}" font-size="34" fill="${MUTED}">${esc(l)}</text>`,
    )
    .join('\n  ');
  return cardShell(
    `<text x="80" y="320" font-family="${FONT}" font-size="92" font-weight="700" fill="${FG}">${esc(BRAND)}</text>
  ${tag}`,
  );
}

function frontmatterTitle(md) {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^title:\s*(.+)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

const png = (svg, file) =>
  sharp(Buffer.from(svg)).png().toFile(join(PUBLIC, file));

async function main() {
  mkdirSync(OG_DIR, { recursive: true });

  // Icons.
  await png(tile(32, 7), 'favicon.ico');
  await png(tile(180, 0), 'apple-touch-icon.png');

  // Default social card.
  await png(defaultCard(), 'og.png');

  // Per-post social cards.
  const posts = readdirSync(BLOG_DIR).filter((f) => /\.(md|mdx)$/.test(f));
  let count = 0;
  for (const file of posts) {
    const slug = file.replace(/\.(md|mdx)$/, '');
    const title = frontmatterTitle(readFileSync(join(BLOG_DIR, file), 'utf8'));
    if (!title) continue;
    await png(postCard(title), join('og', `${slug}.png`));
    count++;
  }

  console.log(`Generated icons + ${count + 1} OG card(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
