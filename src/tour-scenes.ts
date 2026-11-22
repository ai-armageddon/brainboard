// Tiny, local illustrations for the walkthrough. They never touch the board or start a call.
const card = (x: number, y: number, text: string, motion = '') =>
  `<g class="${motion}"><rect class="demo-note" x="${x}" y="${y}" width="72" height="30" rx="5"/><text x="${x + 36}" y="${y + 19}" text-anchor="middle">${text}</text></g>`;
const arrow = '<path class="demo-line" d="M111 47h56m-6-5 6 5-6 5"/>';
const artwork: Record<string, string> = {
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
