// Link previews for shared boards. Board links keep the board id after "#", which browsers never send, so a
// preview bot (Slack, iMessage, Discord, X…) only sees "/?invite=<token>". When that token is a live invite,
// the page it gets carries the board's name instead of the generic Brainboard title.
// Only invite links get this: having the link already grants access, so the name isn't a leak.
import { readBoard } from './store.ts';
import { findInvite, tokenBoards } from './sharing.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Replace the content of <meta name|property="key">. Leaves the page alone if the tag isn't there. */
function setMeta(html: string, key: string, value: string) {
  return html.replace(new RegExp(`(<meta (?:name|property)="${key}" content=")[^"]*(")`), `$1${value}$2`);
}

/**
 * The app page, with title, description, Open Graph and X tags for the board an invite link opens.
 * `origin` is the public address links should use, e.g. https://brainboard.ink.
 */
export async function shareMeta(html: string, requestUrl: string, origin: string): Promise<string> {
  const url = new URL(requestUrl, origin);
  const token = url.searchParams.get('invite');
  if (!token || token.length > 200) return html;
  const [hit] = await tokenBoards(token);
  if (!hit) return html;
  const [board, invite] = await Promise.all([readBoard(hit.boardId), findInvite(hit.boardId, token)]);
  if (!board || !invite) return html;

  const name = clip(board.name.trim() || 'Untitled board', 70);
  const what = invite.role === 'editor' ? 'work on' : 'see';
  const who = invite.from?.trim() ? `${clip(invite.from.trim(), 40)} invited you to ${what}` : `You're invited to ${what}`;
  const title = esc(`${name} · Brainboard`);
  const desc = esc(`${who} “${name}” on Brainboard, the infinite whiteboard for notes, sketches and flow charts.`);
  const link = esc(`${origin}/?invite=${encodeURIComponent(token)}`);

  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  for (const [k, v] of [
    ['description', desc], ['og:title', title], ['og:description', desc], ['og:url', link],
    ['twitter:title', title], ['twitter:description', desc],
    // A private board: fine to preview in a chat, not something for search engines to index.
    ['robots', 'noindex, nofollow'],
  ] as const) out = setMeta(out, k, v);
  return out.replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${link}" />`);
}
