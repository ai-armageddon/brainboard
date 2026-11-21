// Passkeys (WebAuthn) via @simplewebauthn/server. Challenges live in memory for five minutes.
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { PUBLIC_URL } from './config.ts';
import { createUser, newUserId, updateUser, userByPasskey, type Passkey, type User } from './accounts.ts';

const RP_NAME = 'brainboard';

/**
 * The relying party for this request. Hosted: always the public domain. Dev: localhost only, because passkeys
 * need a real hostname (not an IP address like the LAN URLs from `npm run share`).
 */
export function relyingParty(req: IncomingMessage): { rpID: string; origin: string } | null {
  if (PUBLIC_URL) return { rpID: new URL(PUBLIC_URL).hostname, origin: PUBLIC_URL };
  const host = req.headers.host ?? '';
  const hostname = host.replace(/:\d+$/, '');
  if (hostname !== 'localhost') return null;
  return { rpID: 'localhost', origin: `http://${host}` };
}

type Flow =
  | { kind: 'signup'; challenge: string; userId: string; name: string; expires: number }
  | { kind: 'add'; challenge: string; userId: string; expires: number }
  | { kind: 'login'; challenge: string; expires: number };
const flows = new Map<string, Flow>();

function remember(flow: Flow) {
  const now = Date.now();
  for (const [k, f] of flows) if (f.expires < now) flows.delete(k);
  if (flows.size > 10_000) flows.clear();
  const id = crypto.randomBytes(16).toString('base64url');
  flows.set(id, flow);
  return id;
}
function take(id: unknown): Flow | null {
  const f = typeof id === 'string' ? flows.get(id) : undefined;
  if (!f) return null;
  flows.delete(id as string);
  return f.expires > Date.now() ? f : null;
}

const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

/** Start creating a passkey: for a new account (`name`) or for the signed-in `user`. */
export async function registrationOptions(req: IncomingMessage, opts: { name?: string; user?: User | null }) {
  const rp = relyingParty(req);
  if (!rp) throw new Error('Passkeys need a domain name. Open brainboard on localhost or its public address.');
  const userId = opts.user?.id ?? newUserId();
  const name = opts.user?.name ?? opts.name ?? '';
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: opts.user?.email ?? name,
    userDisplayName: name,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: (opts.user?.passkeys ?? []).map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const flow = opts.user
    ? remember({ kind: 'add', challenge: options.challenge, userId, expires: Date.now() + 300_000 })
    : remember({ kind: 'signup', challenge: options.challenge, userId, name, expires: Date.now() + 300_000 });
  return { flow, options };
}

/** Finish creating a passkey. Returns the (possibly new) account. */
export async function registrationVerify(req: IncomingMessage, flowId: unknown, response: RegistrationResponseJSON, picture?: string): Promise<User> {
  const rp = relyingParty(req);
  const flow = take(flowId);
  if (!rp || !flow || flow.kind === 'login') throw new Error('That took too long. Please try again.');
  const v = await verifyRegistrationResponse({
    response, expectedChallenge: flow.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false,
  });
  if (!v.verified) throw new Error('Could not verify the passkey.');
  const c = v.registrationInfo.credential;
  if (userByPasskey(c.id)) throw new Error('This passkey is already registered.');
  const passkey: Passkey = {
    id: c.id, publicKey: toB64(c.publicKey), counter: c.counter, transports: c.transports, created: new Date().toISOString(),
  };
  if (flow.kind === 'signup') return createUser({ id: flow.userId, name: flow.name, passkey, picture });
  const u = await updateUser(flow.userId, (x) => { x.passkeys.push(passkey); });
  if (!u) throw new Error('Account not found.');
  return u;
}

/** Start signing in with any passkey saved for this site (no username needed). */
export async function authenticationOptions(req: IncomingMessage) {
  const rp = relyingParty(req);
  if (!rp) throw new Error('Passkeys need a domain name. Open brainboard on localhost or its public address.');
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
  return { flow: remember({ kind: 'login', challenge: options.challenge, expires: Date.now() + 300_000 }), options };
}

export async function authenticationVerify(req: IncomingMessage, flowId: unknown, response: AuthenticationResponseJSON): Promise<User> {
  const rp = relyingParty(req);
  const flow = take(flowId);
  if (!rp || !flow || flow.kind !== 'login') throw new Error('That took too long. Please try again.');
  const hit = userByPasskey(response.id);
  if (!hit) throw new Error('This passkey isn’t linked to a brainboard account.');
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: flow.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: { id: hit.passkey.id, publicKey: fromB64(hit.passkey.publicKey), counter: hit.passkey.counter, transports: hit.passkey.transports as never },
    requireUserVerification: false,
  });
  if (!v.verified) throw new Error('Could not verify the passkey.');
  await updateUser(hit.user.id, (u) => {
    const p = u.passkeys.find((x) => x.id === hit.passkey.id);
    if (p) p.counter = v.authenticationInfo.newCounter;
  });
  return hit.user;
}
