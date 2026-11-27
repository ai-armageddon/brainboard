// Tiny, local illustrations for the walkthrough. They never touch the board or start a call.
import { icon } from './icons';

const demoIcon = (name: string, x: number, y: number, size: number) =>
  `<g transform="translate(${x} ${y})">${icon(name, size)}</g>`;
const card = (x: number, y: number, text: string, motion = '', width = 72) =>
  `<g class="${motion}"><rect class="demo-note" x="${x}" y="${y}" width="${width}" height="30" rx="5"/><text x="${x + width / 2}" y="${y + 19}" text-anchor="middle">${text}</text></g>`;
const arrow = '<path class="demo-line" d="M111 47h56m-6-5 6 5-6 5"/>';
const artwork: Record<string, string> = {
  recent: `<rect class="demo-card" x="47" y="11" width="186" height="72" rx="6"/>
    ${card(58, 20, 'Idea')}${card(146, 20, 'Draft', 'demo-appear')}
    <text x="59" y="70">Launch plan</text><circle class="demo-finger" cx="196" cy="66" r="8"/><circle class="demo-note" cx="208" cy="66" r="8"/>`,
  search: `<rect class="demo-card" x="36" y="12" width="208" height="70" rx="7"/>
    ${demoIcon('search', 48, 21, 16)}<text x="73" y="34">inventory</text>
    <g class="demo-appear"><path class="demo-guide" d="M48 43h184"/><text x="50" y="60">Launch plan</text>
    <text class="demo-muted" x="50" y="75">Spring launch inventory</text></g>`,
  suggest: `<rect class="demo-note" x="55" y="21" width="170" height="51" rx="5"/>
    <text x="70" y="52">Launch inv<tspan class="demo-muted">entory</tspan></text>
    <g class="demo-appear"><rect class="demo-card" x="182" y="34" width="31" height="22" rx="4"/><text x="188" y="49">Tab</text></g>`,
  browse: `<rect class="demo-card" x="44" y="13" width="192" height="68" rx="6"/>
    ${demoIcon('globe', 55, 20, 15)}<text x="78" y="32">Field guide</text>
    <path class="demo-guide" d="M45 39h190"/><path class="demo-line" d="M59 54h80m-80 12h57"/>
    <g class="demo-appear">${demoIcon('select', 170, 49, 20)}</g>`,
  capture: `${demoIcon('camera', 126, 12, 28)}
    ${card(36, 52, 'Save locally', '', 96)}${card(144, 52, 'Save to Media', 'demo-appear', 100)}`,
  record: `<rect class="demo-card" x="31" y="19" width="218" height="54" rx="8"/>
    ${demoIcon('sound', 43, 29, 14)}<text x="62" y="41">Tab audio</text>
    ${demoIcon('mic', 43, 49, 14)}<text x="62" y="61">Microphone</text>
    <g class="demo-appear"><rect class="demo-card" x="132" y="32" width="108" height="27" rx="12"/>
    <rect x="140" y="41" width="9" height="9" rx="2" fill="var(--danger)"/><text x="156" y="50">Stop recording</text></g>`,
  hand: `<g class="demo-align-b">${card(65, 32, 'Roadmap')}</g>${demoIcon('hand', 148, 29, 33)}
    <rect class="demo-card" x="189" y="34" width="23" height="23" rx="4"/><text x="196" y="50">H</text>`,
  write: `<rect class="demo-note" x="58" y="22" width="168" height="54" rx="5"/><svg x="70" y="28" height="40" class="demo-type"><text x="0" y="24">Plan the next release</text></svg>`,
  connect: card(38, 32, 'Idea') + arrow + card(169, 32, 'Outline', 'demo-appear'),
  snap: `<path class="demo-line demo-rough" pathLength="1" d="M139 16c22-3 35 13 34 29 3 19-13 35-31 35-21 3-39-13-37-32-3-18 14-34 34-32z"/><circle class="demo-line demo-clean" cx="140" cy="48" r="31"/>`,
  align: '<path class="demo-guide" d="M10 66h260"/>' + card(17, 36, 'Outline', 'demo-align-a') + card(104, 36, 'Draft', 'demo-align-b') + card(191, 36, 'Review', 'demo-align-c'),
  image: `<defs><clipPath id="tour-image-clip"><rect class="demo-round" x="107" y="12" width="68" height="68" rx="16"/></clipPath></defs><image href="/icon-192.png" x="107" y="12" width="68" height="68" clip-path="url(#tour-image-clip)"/><g class="demo-upload"><rect x="96" y="47" width="88" height="22" rx="11"/><text x="140" y="62" text-anchor="middle">Uploading…</text></g>`,
  pinch: `<g class="demo-zoom">${card(104,32,'Roadmap')}</g><circle class="demo-finger demo-finger-a" cx="106" cy="61" r="7"/><circle class="demo-finger demo-finger-b" cx="173" cy="36" r="7"/>`,
  invite: `<rect class="demo-card" x="39" y="17" width="202" height="61" rx="7"/><image href="/favicon.svg" x="51" y="30" width="32" height="32"/><text x="95" y="40">Launch plan</text><text class="demo-muted" x="95" y="58">Brainboard invite</text>`,
  voice: `<rect class="demo-card" x="58" y="22" width="164" height="50" rx="8"/><text x="119" y="43">Join voice</text><text class="demo-muted" x="119" y="59">2 in call</text><g class="demo-wave"><path d="M78 43v8m7-15v22m7-18v14m7-10v6"/></g>`,
  views: card(38,32,'Planning') + arrow + card(169,32,'Review', 'demo-appear'),
};

export function tourScene(scene?: string) {
  const content = scene && artwork[scene];
  return content ? `<div class="tour-scene" aria-hidden="true"><svg viewBox="0 0 280 94">${content}</svg></div>` : '';
}
