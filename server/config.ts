// Deployment settings.
//   Local / dev (default): http://localhost:5317. Requests from this machine also see boards that have no owner
//   (older boards, and ones created by AI agents over MCP).
//   Hosted: set BRAINBOARD_PUBLIC_URL, e.g. https://brainboard.ink. Every visitor gets their own boards, and the
//   "this machine is the owner" shortcut is switched off.
export const PROD_URL = 'https://brainboard.ink';

export const PUBLIC_URL = (process.env.BRAINBOARD_PUBLIC_URL ?? '').replace(/\/+$/, '') || null;
export const HOSTED = !!PUBLIC_URL;
export const SECURE_COOKIES = !!PUBLIC_URL?.startsWith('https://');

/**
 * ICE servers for voice chat (WebRTC). STUN lets people behind home routers find each other; for strict
 * corporate networks add a TURN server, e.g.
 *   BRAINBOARD_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
 */
export const ICE_SERVERS: unknown[] = (() => {
  try { return JSON.parse(process.env.BRAINBOARD_ICE_SERVERS ?? '') as unknown[]; } catch { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
})();

/** Behind a reverse proxy, trust X-Forwarded-For for the client address (rate limiting only). */
export const TRUST_PROXY = HOSTED || process.env.BRAINBOARD_TRUST_PROXY === '1';
