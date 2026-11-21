// Run with: node --test scripts/test-connector-auth.ts
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

test('an approved AI connection follows its selected board and current permissions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'brainboard-connector-'));
  process.env.BRAINBOARD_DIR = dir;
  delete process.env.BRAINBOARD_PUBLIC_URL;
  const { handleApi } = await import('../server/api.ts');
  const server = createServer((req, res) => { void handleApi(req, res).then(ok => { if (!ok) res.writeHead(404).end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const resource = base + '/mcp/connect';
  const json = (route: string, data: unknown, cookie = '', method = 'POST') => fetch(base + route, {
    method, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(data),
  });
  const anon = async () => (await fetch(base + '/api/session')).headers.getSetCookie()[0].split(';')[0];
  const owner = await anon(), visitor = await anon();
  const a = await (await json('/api/boards', { name: 'Design board' }, owner)).json();
  const b = await (await json('/api/boards', { name: 'Planning board' }, owner)).json();
  const c = await (await json('/api/boards', { name: 'Private board' }, visitor)).json();
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const registration = await json('/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const authorize = base+'/authorize?' + new URLSearchParams({ client_id, redirect_uri: redirect, response_type:'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method:'S256', state:'my-state', scope:'board', resource });
  const response = await fetch(authorize, { redirect: 'manual' });
  const request = new URL(response.headers.get('location')!).searchParams.get('ai_approval');
  const bound = owner + '; ' + response.headers.getSetCookie()[0].split(';')[0];
  const approval = '/api/ai-consent/' + request;
  assert.equal((await json(approval, { allow: true, boardId: a.id }, visitor)).status, 400);
  assert.equal((await json(approval, { allow: true, boardId: c.id }, bound)).status, 400);
  const approved = new URL((await (await json(approval, { allow: true, boardId: a.id }, bound)).json()).redirect);
  assert.equal(approved.searchParams.get('state'), 'my-state');
  assert.equal((await json(approval, { allow: true, boardId: b.id }, bound)).status, 400);
  const token = (params: Record<string,string>) => fetch(base+'/token', { method:'POST', body:new URLSearchParams({client_id,resource,...params}) });
  const fields = { grant_type:'authorization_code', code:approved.searchParams.get('code')!, redirect_uri:redirect, code_verifier:verifier };
  assert.equal((await token({...fields,code_verifier:'wrong'})).status, 400);
  const exchange = await token(fields);
  assert.equal(exchange.status, 200);
  let tokens = await exchange.json();
  assert.equal((await token(fields)).status, 400);
  const rpc = (name: string, args: Record<string,unknown> = {}, access = tokens.access_token) => fetch(resource, { method:'POST',
    headers:{ authorization:'Bearer '+access, 'content-type':'application/json', accept:'application/json, text/event-stream' },
    body:JSON.stringify({ jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args} }) });
  const tools = async (name: string, args?: Record<string,unknown>) => (await (await rpc(name,args)).json()).result;
  const listed = (await tools('list_boards')).content[0].text;
  assert.match(listed,/Design board/); assert.doesNotMatch(listed,/Planning board|Private board/);
  assert.equal((await tools('read_board',{board:b.id})).isError,true);
  assert.equal((await tools('create_board',{name:'outside'})).isError,true);
  assert.ok(!(await tools('add_items',{items:[{type:'note',text:'From chat'}]})).isError);
  assert.match((await tools('read_board')).content[0].text,/From chat/);
  const { keys } = await (await fetch(base+'/api/mcp-keys',{headers:{cookie:owner}})).json();
  const keyPath = '/api/mcp-keys/'+keys[0].id;
  assert.equal((await json(keyPath,{boardId:b.id},owner,'PATCH')).status,200);
  assert.equal((await tools('read_board',{board:a.id})).isError,true);
  assert.match((await tools('read_board')).content[0].text,/Planning board/);
  assert.equal((await json(keyPath,{boardId:c.id},owner,'PATCH')).status,403);
  const { createInvite, noteInviteUse, revokeInvite } = await import('../server/sharing.ts');
  const { anonKey } = await import('../server/auth.ts');
  const invite = await createInvite(c.id, 'viewer', 'Reviewer');
  const ownerKey = anonKey(createHash('sha256').update(owner.split('=')[1]).digest('base64url').slice(0,22));
  await noteInviteUse(c.id,invite.token,'Reviewer',ownerKey);
  assert.equal((await json(keyPath,{boardId:c.id},owner,'PATCH')).status,200);
  assert.match((await tools('read_board')).content[0].text,/Private board/);
  assert.equal((await tools('add_items',{items:[{type:'note',text:'no'}]})).isError,true);
  await revokeInvite(c.id,invite.token);
  assert.equal((await tools('read_board')).isError,true);
  const previous=tokens;
  tokens=await (await token({grant_type:'refresh_token',refresh_token:previous.refresh_token})).json();
  assert.ok(tokens.access_token);
  assert.equal((await rpc('list_boards',{},previous.access_token)).status,401);
  assert.equal((await token({grant_type:'refresh_token',refresh_token:previous.refresh_token})).status,400);
  assert.equal((await fetch(base+keyPath,{method:'DELETE',headers:{cookie:owner}})).status,200);
  assert.equal((await rpc('list_boards')).status,401);
  assert.equal((await token({grant_type:'refresh_token',refresh_token:tokens.refresh_token})).status,400);
});
