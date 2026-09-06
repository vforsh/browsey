import { describe, expect, test } from 'bun:test'
import { accessTokenGate } from './server.js'
import { ACCESS_TOKEN_HEADER, describeAccessProtection } from '@vforsh/browsey-shared'

const TOKEN = 'kQ8s-JfP0hWm3Zt6Xy1nR4bLcVdEgAoUiTsNrYuQwEk'

type RequestInitLite = {
  method?: string
  token?: string | null
}

function request(path: string, { method = 'GET', token = null }: RequestInitLite = {}): Request {
  const headers = new Headers()
  if (token !== null) headers.set(ACCESS_TOKEN_HEADER, token)
  return new Request(`http://localhost:4200${path}`, { method, headers })
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: string }
  return body.error ?? ''
}

describe('access token gate — protection off', () => {
  test('lets every request through untouched when no token is configured', () => {
    for (const path of ['/api/health', '/api/list?path=/', '/api/reload', '/api/agents']) {
      expect(accessTokenGate(request(path), undefined)).toBeNull()
    }
    expect(accessTokenGate(request('/api/save', { method: 'POST' }), undefined)).toBeNull()
  })

  test('an empty configured token is not protection', () => {
    expect(accessTokenGate(request('/api/health'), '')).toBeNull()
  })

  test('a client sending a token anyway is not rejected', () => {
    expect(accessTokenGate(request('/api/health', { token: 'whatever' }), undefined)).toBeNull()
  })
})

describe('access token gate — protection on', () => {
  test('a missing token is 401 with the contract message', async () => {
    const response = accessTokenGate(request('/api/list?path=/'), TOKEN)
    expect(response).not.toBeNull()
    expect(response!.status).toBe(401)
    expect(response!.headers.get('Content-Type')).toBe('application/json')
    expect(await errorOf(response!)).toBe('Browsey access token required')
  })

  test('the challenge names this gate, not the agent one', () => {
    // The client has to tell an origin refusal from an agent refusal without
    // reading the message text; `Bearer realm="Browsey API"` means the latter.
    for (const req of [
      request('/api/list?path=/'),
      request('/api/list?path=/', { token: 'nope' }),
    ]) {
      const response = accessTokenGate(req, TOKEN)
      expect(response!.headers.get('WWW-Authenticate')).toBe('Browsey-Access')
    }
  })

  test('an empty header value counts as missing', async () => {
    const response = accessTokenGate(request('/api/list?path=/', { token: '  ' }), TOKEN)
    expect(response!.status).toBe(401)
    expect(await errorOf(response!)).toBe('Browsey access token required')
  })

  test('a wrong token is 401 and is never echoed back', async () => {
    const response = accessTokenGate(request('/api/list?path=/', { token: 'nope' }), TOKEN)
    expect(response).not.toBeNull()
    expect(response!.status).toBe(401)
    expect(await errorOf(response!)).toBe('Invalid Browsey access token')
    expect(await response!.clone().text()).not.toContain('nope')
  })

  test('a token of the right length but wrong bytes is still rejected', async () => {
    const nearMiss = `${TOKEN.slice(0, -1)}X`
    const response = accessTokenGate(request('/api/view?path=/a.txt', { token: nearMiss }), TOKEN)
    expect(response!.status).toBe(401)
    expect(await errorOf(response!)).toBe('Invalid Browsey access token')
  })

  test('the correct token passes', () => {
    expect(accessTokenGate(request('/api/list?path=/', { token: TOKEN }), TOKEN)).toBeNull()
    expect(
      accessTokenGate(request('/api/save', { method: 'POST', token: TOKEN }), TOKEN)
    ).toBeNull()
  })

  test('the header is matched case-insensitively, as HTTP requires', () => {
    const headers = new Headers({ 'x-browsey-access-token': TOKEN })
    const req = new Request('http://localhost:4200/api/health', { headers })
    expect(accessTokenGate(req, TOKEN)).toBeNull()
  })

  test('a token in the query string does not open the gate', async () => {
    const req = new Request(`http://localhost:4200/api/file?path=/a.txt&token=${TOKEN}`)
    const response = accessTokenGate(req, TOKEN)
    expect(response!.status).toBe(401)
    expect(await errorOf(response!)).toBe('Browsey access token required')
  })

  test('OPTIONS passes without a token so CORS preflight still works', () => {
    expect(accessTokenGate(request('/api/list', { method: 'OPTIONS' }), TOKEN)).toBeNull()
  })

  test('/api/health is gated', async () => {
    const response = accessTokenGate(request('/api/health'), TOKEN)
    expect(response!.status).toBe(401)
    expect(accessTokenGate(request('/api/health', { token: TOKEN }), TOKEN)).toBeNull()
  })

  test('/api/reload is gated, ahead of the SSE branch', async () => {
    const response = accessTokenGate(request('/api/reload'), TOKEN)
    expect(response!.status).toBe(401)
    expect(accessTokenGate(request('/api/reload', { token: TOKEN }), TOKEN)).toBeNull()
  })

  test('agent routes are gated before their own bearer check', async () => {
    const headers = new Headers({ Authorization: `Bearer ${TOKEN}` })
    const req = new Request('http://localhost:4200/api/agents?path=/', { headers })
    const response = accessTokenGate(req, TOKEN)
    expect(response!.status).toBe(401)
    expect(await errorOf(response!)).toBe('Browsey access token required')
  })

  test('non-API paths are not gated — the bundled web UI still loads', () => {
    for (const path of ['/', '/index.html', '/assets/app.js', '/api']) {
      expect(accessTokenGate(request(path), TOKEN)).toBeNull()
    }
  })
})

describe('startup banner', () => {
  test('says on or off and never the value', () => {
    const on = describeAccessProtection(TOKEN)
    expect(on).toContain(ACCESS_TOKEN_HEADER)
    expect(on).not.toContain(TOKEN)
    expect(describeAccessProtection(undefined)).toContain('off')
  })
})
