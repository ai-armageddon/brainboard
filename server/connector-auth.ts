// OAuth for the board-scoped connector. The MCP SDK handles discovery, client authentication and PKCE.
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { DATA_DIR } from './store.ts';
import { cookie, isLocalRequest, ownerKeyOf, setCookie, type Principal } from './auth.ts';
import { PUBLIC_URL } from './config.ts';
import { aiBoards } from './remote-mcp.ts';
import { findKey, issueBoardGrant, refreshBoardGrant } from './keys.ts';

const random = () => crypto.randomBytes(32).toString('base64url');
const directory = path.join(DATA_DIR, 'accounts', 'oauth-clients');
interface Attempt {
  clientId: string; provider: string; params: AuthorizationParams; resource: string;
  browser: string; expires: number;
}
interface Code extends Attempt { owner: string; local: boolean; boardId: string }
const requests = new Map<string, Attempt>();
const codes = new Map<string, Code>();

function providerFor(uri: string) {
  if (uri === 'https://claude.ai/api/mcp/auth_callback') return 'Claude';
  if (uri === 'https://chatgpt.com/connector_platform_oauth_redirect' ||
      /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(uri)) return 'ChatGPT';
  throw new InvalidClientMetadataError('Choose a ChatGPT or Claude connector callback.');
}

function validateScope(scopes?: string[]) {
  if (scopes?.some(s => s !== 'board')) throw new InvalidScopeError('Only board access is available.');
}

function prune() {
  for (const entries of [requests, codes]) {
    for (const [id, attempt] of entries) if (attempt.expires <= Date.now()) entries.delete(id);
  }
}

function getCode(clientId: string, id: string) {
  const code = codes.get(id);
  if (!code || code.clientId !== clientId || code.expires <= Date.now()) throw new InvalidGrantError('Start the connection again.');
  return code;
}

function buildRouter(base: string) {
  const resource = base + '/mcp/connect';
  const provider: OAuthServerProvider = {
    clientsStore: {
      async registerClient(metadata) {
        if (metadata.token_endpoint_auth_method && !['none', 'client_secret_post'].includes(metadata.token_endpoint_auth_method)) {
          throw new InvalidClientMetadataError('Choose automatic registration with a supported token authentication method.');
        }
        const callbacks = metadata.redirect_uris;
        if (!callbacks.length || callbacks.length > 8 || new Set(callbacks.map(providerFor)).size !== 1) {
          throw new InvalidClientMetadataError('Register one provider per client.');
        }
        const client = { ...metadata, client_id: crypto.randomUUID(), client_name: providerFor(callbacks[0]) };
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(directory, client.client_id), JSON.stringify(client), { mode: 0o600, flag: 'wx' });
        return client;
      },
      async getClient(id) {
        if (!/^[a-f0-9-]{36}$/.test(id)) return undefined;
        try { return JSON.parse(await fs.readFile(path.join(directory, id), 'utf8')) as OAuthClientInformationFull; }
        catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err; }
      },
    },
    async authorize(client, params, res) {
      validateScope(params.scopes);
      if (params.resource && params.resource.href !== resource) throw new InvalidRequestError('Unknown resource.');
      prune();
      const id = random(), browser = random();
      requests.set(id, { clientId: client.client_id, provider: providerFor(params.redirectUri), params,
        browser, resource, expires: Date.now() + 600_000 });
      setCookie(res, 'bb_ai_' + id, browser, 600);
      res.redirect(base + '/?ai_approval=' + id);
    },
    async challengeForAuthorizationCode(client, code) { return getCode(client.client_id, code).params.codeChallenge; },
    async exchangeAuthorizationCode(client, id, _verifier, redirect, audience) {
      const code = getCode(client.client_id, id);
      if (code.params.redirectUri !== redirect || code.resource !== resource || (audience && audience.href !== resource)) {
        throw new InvalidGrantError('Authorization parameters changed.');
      }
      codes.delete(id);
      return issueBoardGrant(code.owner, code.local, code.provider, client.client_id, resource, code.boardId);
    },
    async exchangeRefreshToken(client, refresh, scopes, audience) {
      validateScope(scopes);
      if (audience && audience.href !== resource) throw new InvalidGrantError('Unknown resource.');
      const tokens = await refreshBoardGrant(client.client_id, resource, refresh);
      if (!tokens) throw new InvalidGrantError('Reconnect Brainboard.');
      return tokens;
    },
    async verifyAccessToken(token) {
      const key = findKey(token);
      if (!key?.grant || key.grant.resource !== resource) throw new InvalidTokenError('Reconnect Brainboard.');
      return { token, clientId: key.grant.clientId, scopes: ['board'], resource: new URL(resource), expiresAt: key.grant.expires / 1000 };
    },
  };
  const app = express();
  app.disable('x-powered-by');
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(base), resourceServerUrl: new URL(resource),
    resourceName: 'Brainboard', scopesSupported: ['board'], clientRegistrationOptions: { clientSecretExpirySeconds: 0 } }));
  return app;
}

const endpoints = new Set(['/authorize', '/token', '/register', '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/mcp/connect']);
const routers = new Map<string, ReturnType<typeof buildRouter>>();
export function serveConnectorAuth(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!endpoints.has(pathname)) return false;
  const base = PUBLIC_URL ?? (isLocalRequest(req) ? 'http://' + req.headers.host : '');
  if (!base || (PUBLIC_URL && !PUBLIC_URL.startsWith('https://'))) { res.writeHead(400).end('Set BRAINBOARD_PUBLIC_URL to your public HTTPS address.'); return true; }
  let router = routers.get(base);
  if (!router) { router = buildRouter(base); routers.set(base, router); }
  router(req, res);
  return true;
}

export async function connectorConsent(req: IncomingMessage, p: Principal, id: string, decision?: { boardId?: string; allow?: boolean }) {
  const pending = requests.get(id);
  if (!pending || pending.expires <= Date.now() || cookie(req, 'bb_ai_' + id) !== pending.browser) {
    throw new Error('This connection request expired. Open Brainboard from your AI app again.');
  }
  if (!decision) return { provider: pending.provider };
  const callback = new URL(pending.params.redirectUri);
  if (pending.params.state) callback.searchParams.set('state', pending.params.state);
  if (decision.allow === true) {
    const owner = ownerKeyOf(p);
    if (!owner || !decision.boardId || !(await aiBoards(p, decision.boardId)).length) throw new Error('Choose a board you can access.');
    const code = random();
    if (!requests.delete(id)) throw new Error('This request has already been used.');
    codes.set(code, { ...pending, owner, local: p.local, boardId: decision.boardId, expires: Date.now() + 60_000 });
    callback.searchParams.set('code', code);
  } else {
    requests.delete(id);
    callback.searchParams.set('error', 'access_denied');
  }
  return { redirect: callback.href };
}
