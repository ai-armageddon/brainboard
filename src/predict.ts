// Guess the word being typed from the words already on the board and a list of common English words.
// It all happens in the browser: nothing typed is sent anywhere.

export interface Dictionary { words: string[]; weight: number[]; known: Set<string> }
/** Lowercase word → how it is written on the board and how often. */
export type BoardWords = Map<string, { word: string; count: number }>;

const MIN_TYPED = 3;
/** A suggestion has to save at least this many keystrokes. */
const MIN_GAIN = 2;
/** Share of likely words that must begin with the guess. Stricter when what's typed is already a word. */
const SURE = 0.55, SURE_FOR_A_WORD = 0.8;

/** words.txt: most common first, and each line holds words about √2 times rarer than the line before. */
export function parseDictionary(raw: string): Dictionary {
  const words: string[] = [], weight: number[] = [];
  raw.split('\n').forEach((line, tier) => {
    for (const word of line.split(' ')) {
      if (!word) continue;
      words.push(word);
      weight.push(2 ** (-tier / 2));
    }
  });
  return { words, weight, known: new Set(words) };
}

export function collectWords(texts: Iterable<string>): BoardWords {
  const found: BoardWords = new Map();
  for (const text of texts) {
    for (const [word] of text.matchAll(/\p{L}[\p{L}\p{N}]*/gu)) {
      if (word.length < MIN_TYPED + MIN_GAIN) continue;
      const key = word.toLowerCase();
      const seen = found.get(key);
      if (seen) seen.count++;
      else found.set(key, { word, count: 1 });
    }
  }
  return found;
}

function fromBoard(typed: string, lists: BoardWords[], dict: Dictionary | null) {
  if (dict?.known.has(typed) || lists.some((list) => list.has(typed))) return null; // already a whole word
  let best: { word: string; count: number } | null = null;
  for (const list of lists) {
    for (const [key, entry] of list) {
      if (key.length < typed.length + MIN_GAIN || !key.startsWith(typed)) continue;
      if (!best || entry.count > best.count || (entry.count === best.count && entry.word.length < best.word.length)) best = entry;
    }
  }
  return best?.word ?? null;
}

function fromDictionary(typed: string, dict: Dictionary) {
  let total = 0, guess = '';
  const matches: number[] = [];
  for (let i = 0; i < dict.words.length; i++) {
    const word = dict.words[i];
    if (!word.startsWith(typed)) continue;
    matches.push(i);
    total += dict.weight[i];
    if (!guess && word.length >= typed.length + MIN_GAIN) guess = word; // the list is sorted, so this is the likeliest
  }
  if (!guess) return null;
  // "develop" also counts toward "developer": accepting the guess is still a step toward those words.
  let agree = 0;
  for (const i of matches) if (dict.words[i].startsWith(guess)) agree += dict.weight[i];
  return agree / total >= (dict.known.has(typed) ? SURE_FOR_A_WORD : SURE) ? guess : null;
}

/**
 * The letters to add after `typed`, or null when no guess is good enough to show. `start` is how the typed
 * letters should read once accepted: a name from the board keeps its capitals ("kub" → "Kubernetes").
 * `board` is one or more word lists; a word in any of them counts.
 */
export function completion(typed: string, board: BoardWords[], dict: Dictionary | null): { start: string; rest: string } | null {
  if (typed.length < MIN_TYPED) return null;
  const lower = typed.toLowerCase();
  if (lower.length !== typed.length) return null;
  const named = fromBoard(lower, board, dict);
  const word = named ?? (dict && fromDictionary(lower, dict));
  if (!word) return null;
  const rest = word.slice(typed.length);
  if (typed === typed.toUpperCase()) return { start: typed, rest: rest.toUpperCase() };
  return { start: named && typed === lower ? word.slice(0, typed.length) : typed, rest };
}
