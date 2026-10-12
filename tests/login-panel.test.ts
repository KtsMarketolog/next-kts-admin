import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import { LOGIN_DELIVERY_ERROR, LOGIN_NETWORK_ERROR, LOGIN_SERVER_ERROR, requestLogin, type LoginMode } from '../src/features/auth/loginRequest';

const credentials = { login: 'synthetic@example.test', password: 'synthetic-password' };
const challenge = { twoFactorChallengeId: 'synthetic-challenge', twoFactorCode: '123456' };

for (const mode of ['employee', 'client'] as const) {
  test(`${mode}: login request separates authentication, delivery, rate limit and server failures`, async () => {
    for (const payload of [credentials, challenge]) {
      for (const [status, data, message] of [
        [401, { error: 'private server detail' }, 'twoFactorChallengeId' in payload
          ? 'Код неверен или больше не действует. Введите пароль заново, чтобы получить новый.' : 'Неверный логин или пароль'],
        [429, { error: 'private server detail' }, 'Слишком много попыток. Попробуйте позже.'],
        [503, { code: 'TWO_FACTOR_DELIVERY_FAILED', error: 'private SMTP detail' }, LOGIN_DELIVERY_ERROR],
        [503, { code: 'LOGIN_UNAVAILABLE', error: 'private database detail' }, LOGIN_SERVER_ERROR],
        [500, { error: 'private server detail' }, LOGIN_SERVER_ERROR],
        [403, { error: 'private server detail' }, LOGIN_SERVER_ERROR],
      ] as const) {
        const result = await requestLogin(mode, payload, async (url, init) => {
          assert.equal(url, mode === 'client' ? '/api/client/login' : '/api/admin/login');
          assert.deepEqual(JSON.parse(String(init?.body)), payload);
          return Response.json(data, { status });
        });
        assert.deepEqual(result, { kind: 'error', message });
      }
    }
  });

  test(`${mode}: network failure and malformed success cannot navigate as a successful login`, async () => {
    const failed = await requestLogin(mode, credentials, async () => { throw new Error('private network detail'); });
    assert.deepEqual(failed, { kind: 'error', message: LOGIN_NETWORK_ERROR });
    for (const value of [null, [], {}, { ok: false }, { twoFactorRequired: true }, { ok: true, twoFactorRequired: true }]) {
      assert.deepEqual(await requestLogin(mode, credentials, async () => Response.json(value)), { kind: 'error', message: LOGIN_SERVER_ERROR });
    }
    for (const status of [200, 500, 502]) {
      assert.deepEqual(await requestLogin(mode, credentials, async () => new Response('<html>private proxy detail</html>', { status })),
        { kind: 'error', message: LOGIN_SERVER_ERROR });
    }
    assert.deepEqual(await requestLogin(mode, credentials, async () => Response.json({ ok: false, twoFactorRequired: true, challengeId: 'new-challenge', email: 'sy***@example.test' })),
      { kind: 'challenge', challengeId: 'new-challenge', email: 'sy***@example.test' });
    assert.deepEqual(await requestLogin(mode, credentials, async () => Response.json({ ok: true, role: 'manager' })),
      { kind: 'success', role: 'manager' });
  });
}

type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const item = node as Element;
  return [item, ...elements(item.props.children)];
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (!node || typeof node !== 'object' || !('props' in node)) return '';
  return text((node as Element).props.children);
}

const panelCode = ts.transpileModule(readFileSync('src/features/auth/LoginPanel.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function panel(mode: LoginMode, fetchImpl: typeof fetch, onEmployeeAuthenticated?: () => Promise<void>) {
  const slots: unknown[] = [];
  let cursor = 0;
  const navigation: string[] = [];
  const modules: Record<string, unknown> = {
    react: { useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => { slots[index] = next; }];
    } },
    'react/jsx-runtime': jsx,
    'next/link': { default: 'a' },
    'next/navigation': { useRouter: () => ({ push: (url: string) => navigation.push(url), refresh: () => navigation.push('refresh') }) },
    '@/shared/lib/adminNavigation': { EMPLOYEE_HOME_PATH: '/admin' },
    './LoginPanel.module.scss': { default: {} },
    './loginRequest': { LOGIN_SERVER_ERROR, requestLogin: (type: LoginMode, payload: typeof credentials) => requestLogin(type, payload, fetchImpl) },
  };
  const exports = {} as { LoginPanel: (props: unknown) => unknown };
  runInNewContext(panelCode, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
  const render = () => { cursor = 0; return exports.LoginPanel({ defaultMode: mode, onEmployeeAuthenticated }); };
  const field = (autocomplete: string) => {
    const element = elements(render()).find((node) => node.type === 'input' && node.props.autoComplete === autocomplete);
    assert.ok(element, `Missing input ${autocomplete}`);
    return element;
  };
  const change = (autocomplete: string, value: string) => {
    const callback = field(autocomplete).props.onChange as (event: unknown) => void;
    callback({ target: { value } });
  };
  const submit = () => {
    const form = elements(render()).find((node) => node.type === 'form');
    assert.ok(form);
    return (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
  };
  const busy = () => elements(render()).find((node) => node.type === 'button' && node.props.disabled !== undefined)?.props.disabled;
  return { render, field, change, submit, busy, navigation };
}

for (const mode of ['employee', 'client'] as const) {
  test(`${mode}: actual login form recovers from network failure and allows retry`, async () => {
    let calls = 0;
    let rejectRequest: (reason: unknown) => void = () => {};
    const pending = new Promise<Response>((_resolve, reject) => { rejectRequest = reject; });
    const h = panel(mode, async () => {
      calls++;
      if (calls === 1) return pending;
      return Response.json({ ok: true, role: 'manager' });
    });
    h.change('username', credentials.login);
    h.change('current-password', credentials.password);
    const first = h.submit();
    assert.equal(h.busy(), true);
    await h.submit();
    assert.equal(calls, 1, 'busy form does not send another login');
    rejectRequest(new Error('private network detail'));
    await first;
    assert.equal(h.busy(), false);
    assert.ok(text(h.render()).includes(LOGIN_NETWORK_ERROR));
    assert.equal(h.field('current-password').props.value, credentials.password);
    assert.deepEqual(h.navigation, []);
    await h.submit();
    assert.deepEqual(h.navigation, mode === 'client' ? ['/cabinet', 'refresh'] : ['/admin']);
    assert.equal(h.busy(), false);
  });

  test(`${mode}: OTP stays selected after transient failure and password is cleared only after challenge`, async () => {
    const payloads: unknown[] = [];
    let calls = 0;
    const h = panel(mode, async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      calls++;
      if (calls === 1) return Response.json({ twoFactorRequired: true, challengeId: challenge.twoFactorChallengeId, email: 'sy***@example.test' });
      if (calls === 2) return new Response('private proxy detail', { status: 502 });
      return Response.json({ ok: true, role: 'manager' });
    });
    h.change('username', credentials.login);
    h.change('current-password', credentials.password);
    await h.submit();
    h.change('one-time-code', challenge.twoFactorCode);
    await h.submit();
    assert.ok(text(h.render()).includes(LOGIN_SERVER_ERROR));
    assert.equal(h.field('one-time-code').props.value, challenge.twoFactorCode);
    assert.equal(h.busy(), false);
    assert.deepEqual(h.navigation, []);
    await h.submit();
    assert.deepEqual(payloads, [credentials, challenge, challenge]);
    assert.equal(h.busy(), false);
  });

  test(`${mode}: mail delivery error stays on password form with an actionable message`, async () => {
    const h = panel(mode, async () => Response.json({ code: 'TWO_FACTOR_DELIVERY_FAILED', error: 'private SMTP password' }, { status: 503 }));
    h.change('current-password', credentials.password);
    await h.submit();
    assert.ok(text(h.render()).includes(LOGIN_DELIVERY_ERROR));
    assert.doesNotMatch(text(h.render()), /private|Неверный логин/);
    assert.equal(h.field('current-password').props.value, credentials.password);
    assert.equal(h.busy(), false);
    assert.deepEqual(h.navigation, []);
  });
}

test('employee form restores submit when authentication callback fails', async () => {
  const h = panel('employee', async () => Response.json({ ok: true, role: 'admin' }), async () => { throw new Error('private callback details'); });
  await h.submit();
  assert.equal(h.busy(), false);
  assert.ok(text(h.render()).includes(LOGIN_SERVER_ERROR));
  assert.deepEqual(h.navigation, []);
});
