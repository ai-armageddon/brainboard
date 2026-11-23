// Build src/words.txt, the word list behind the typing suggestions: node scripts/words.ts
// Common English words, most frequent first. Line n holds the words about 2^(n/2) times rarer than the
// most common one, so the app can tell how likely each word is without storing a count for every word.
//
// Sources, fetched when this runs:
//   word counts  https://norvig.com/ngrams/count_1w.txt (from the Google Web Trillion Word Corpus)
//   dictionary   https://github.com/dolph/dictionary enable1.txt (ENABLE, public domain)
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const COUNTS = 'https://norvig.com/ngrams/count_1w.txt';
const DICTIONARY = 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt';
const SIZE = 16000;
/** Nobody wants these offered to them mid-sentence. Matched against the start of a word. */
const RUDE = /^(anal|anus|arse|ass(es|hole)?$|bastard|bitch|blowjob|boob|bugger|clit|cock(s|sucker)?$|coon|crap|cum(s|shot)?$|cunt|damn|dick|dildo|dyke|fag|fuck|goddam|homo$|horny|jerk(off)?$|jizz|kike|milf|nazi|negro|nigg|nude|orgasm|penis|piss|porn|prick|pussy|queer|rape|rapist|retard|sex|shit|slut|spic$|tit(s|ty|ties)?$|twat|vagina|wank|whore)/;

const get = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
};

const [counts, dictionary] = await Promise.all([get(COUNTS), get(DICTIONARY)]);
const real = new Set(dictionary.split(/\r?\n/));
const rows = counts.split('\n')
  .map((line) => line.split('\t'))
  .filter(([word]) => word.length >= 3 && real.has(word) && !RUDE.test(word))
  .slice(0, SIZE);

const top = Number(rows[0][1]);
const tiers: string[][] = [];
for (const [word, count] of rows) (tiers[Math.round(2 * Math.log2(top / Number(count)))] ??= []).push(word);

const out = path.resolve(import.meta.dirname, '../src/words.txt');
writeFileSync(out, Array.from(tiers, (tier) => (tier ?? []).join(' ')).join('\n') + '\n');
console.log(`${rows.length} words in ${tiers.length} tiers → ${out}`);
