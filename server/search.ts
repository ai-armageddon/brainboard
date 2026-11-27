import type { BoardSearchHit } from '../src/protocol.ts';
import { owns, type Principal } from './auth.ts';
import { liveBoard } from './realtime.ts';
import type { Invite } from './sharing.ts';
import { listBoardIds, readBoard } from './store.ts';

export async function searchBoards(
  principal: Principal, invited: { boardId: string; invite: Invite }[], query: string, cancelled: () => boolean,
): Promise<BoardSearchHit[]> {
  const needle = query.trim().toLowerCase().slice(0, 120);
  if (!needle) return [];
  const words = needle.split(/\s+/);
  const invites = new Map(invited.map(b => [b.boardId, b.invite.token]));
  const hits: { hit: BoardSearchHit; rank: number; updated: string }[] = [];
  for (const id of await listBoardIds()) {
    if (cancelled()) break;
    const token = invites.get(id);
    if (!token && !await owns(principal, id)) continue;
    const board = await liveBoard(id) ?? await readBoard(id);
    if (!board) continue;
    const hit: BoardSearchHit = { id, name: board.name, token };
    const title = board.name.toLowerCase();
    let rank = title === needle ? 0 : title.includes(needle) ? 1 : 2;
    if (!words.every(word => title.includes(word))) {
      rank = 3;
      for (const item of board.items) {
        const value = item.type === 'edge' ? item.label : 'text' in item ? item.text : '';
        if (typeof value !== 'string' || !value) continue;
        const line = value.replace(/\s+/g, ' ').trim();
        const lower = line.toLowerCase();
        if (!words.every(word => lower.includes(word))) continue;
        const start = Math.max(0, lower.indexOf(words[0]) - 30);
        hit.excerpt = (start ? '…' : '') + line.slice(start, start + 120) + (line.length > start + 120 ? '…' : '');
        break;
      }
      if (!hit.excerpt) continue;
    }
    hits.push({ hit, rank, updated: board.updated });
  }
  return hits.sort((a, b) => a.rank - b.rank || b.updated.localeCompare(a.updated)).slice(0, 30).map(row => row.hit);
}
