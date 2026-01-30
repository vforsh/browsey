export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

export function corsPreflightResponse(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  })
}

export function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response

  const headers = new Headers(response.headers)
  const cors = corsHeaders(origin)
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
