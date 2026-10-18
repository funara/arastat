import { GOOGLE_DEFAULT_MODEL, effectiveSettings, type AiSettings } from './settings.ts'
import { isIP } from 'node:net'

/**
 * Safe adapter for the Google Gemini and OpenAI-compatible contracts.
 * provider='google' dispatches to Google's generateContent endpoint.
 * provider='custom' dispatches to the configured OpenAI-compatible endpoint with Bearer auth.
 */
export interface ModelCallMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ModelCallErrorKind = 'configuration' | 'validation' | 'network' | 'response' | 'parse' | 'unknown'

export class ModelCallError extends Error {
  readonly status?: number
  readonly kind: ModelCallErrorKind

  constructor(message: string, status?: number, kind: ModelCallErrorKind = 'unknown') {
    super(message)
    this.name = 'ModelCallError'
    this.status = status
    this.kind = kind
  }
}

export const REQUEST_TIMEOUT_MS = 120_000

const IPV4_SENSITIVE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00ffffff], // unspecified/current network
  [0x0a000000, 0x0affffff], // private
  [0x64400000, 0x647fffff], // shared address space
  [0x7f000000, 0x7fffffff], // loopback
  [0xa9fe0000, 0xa9feffff], // link-local
  [0xac100000, 0xac1fffff], // private
  [0xc0000000, 0xc00000ff], // special-purpose
  [0xc0000200, 0xc00002ff], // documentation
  [0xc0a80000, 0xc0a8ffff], // private
  [0xc6120000, 0xc613ffff], // benchmarking
  [0xc6336400, 0xc63364ff], // documentation
  [0xcb007100, 0xcb0071ff], // documentation
  [0xe0000000, 0xffffffff] // multicast/reserved
]

function ipv4Value(hostname: string): number | undefined {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return undefined
  const octets = parts.map(Number)
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
  return ((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!
}

function isSensitiveIpv4(hostname: string): boolean {
  const value = ipv4Value(hostname)
  return value !== undefined && IPV4_SENSITIVE_RANGES.some(([start, end]) => value >= start && value <= end)
}

function parseIpv6Words(hostname: string): number[] | undefined {
  const halves = hostname.split('::')
  if (halves.length > 2) return undefined
  const parseHalf = (part: string): number[] | undefined => {
    if (!part) return []
    const words: number[] = []
    for (const piece of part.split(':')) {
      if (!piece) return undefined
      if (piece.includes('.')) {
        const value = ipv4Value(piece)
        if (value === undefined) return undefined
        words.push(Math.floor(value / 0x10000), value % 0x10000)
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined
        words.push(Number.parseInt(piece, 16))
      }
    }
    return words
  }

  const left = parseHalf(halves[0] ?? '')
  const right = parseHalf(halves.length === 2 ? halves[1] ?? '' : '')
  if (!left || !right) return undefined
  const total = left.length + right.length
  if (halves.length === 2) {
    if (total >= 8) return undefined
    return [...left, ...new Array(8 - total).fill(0), ...right]
  }
  return total === 8 ? left : undefined
}

function isSensitiveIpv6(hostname: string): boolean {
  const words = parseIpv6Words(hostname)
  if (!words) return true
  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  if (mappedIpv4) {
    const value = words[6]! * 0x10000 + words[7]!
    const ipv4 = [
      Math.floor(value / 0x1000000),
      Math.floor(value / 0x10000) % 256,
      Math.floor(value / 0x100) % 256,
      value % 256
    ].join('.')
    return isSensitiveIpv4(ipv4)
  }
  const first = words[0]!
  return first === 0 ||
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xffc0) === 0xfec0 || // site-local
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && words[1] === 0x0db8) // documentation
}

function isSensitiveNetworkHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, '')
  const address = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized
  const ipVersion = isIP(address)
  if (ipVersion === 4) return isSensitiveIpv4(address)
  if (ipVersion === 6) return isSensitiveIpv6(address)
  return address === 'localhost' || address.endsWith('.localhost') || address.endsWith('.local')
}

export function isLocalhost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '127.0.0.1' || normalized === '::1'
}

function endpointFor(baseUrl: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(typeof baseUrl === 'string' ? baseUrl.trim() : '')
  } catch {
    throw new ModelCallError('The AI provider URL is invalid. Use a public HTTPS or local OpenAI-compatible endpoint.', undefined, 'configuration')
  }
  const local = isLocalhost(endpoint.hostname)
  const validProtocol = endpoint.protocol === 'https:' || (local && endpoint.protocol === 'http:')
  if (
    !validProtocol ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (!local && isSensitiveNetworkHost(endpoint.hostname))
  ) {
    throw new ModelCallError('The AI provider URL must be a public HTTPS endpoint or local HTTP endpoint without embedded credentials, query strings, or fragments.', undefined, 'configuration')
  }
  const basePath = endpoint.pathname.replace(/\/+$/, '')
  const completionPath = '/chat/completions'
  endpoint.pathname = basePath === completionPath || basePath.endsWith(completionPath)
    ? basePath
    : `${basePath}${completionPath}`
  return endpoint.toString()
}

export function modelsEndpointFor(baseUrl: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(typeof baseUrl === 'string' ? baseUrl.trim() : '')
  } catch {
    throw new ModelCallError('The AI provider URL is invalid. Use a public HTTPS or local OpenAI-compatible endpoint.', undefined, 'configuration')
  }
  const local = isLocalhost(endpoint.hostname)
  const validProtocol = endpoint.protocol === 'https:' || (local && endpoint.protocol === 'http:')
  if (
    !validProtocol ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (!local && isSensitiveNetworkHost(endpoint.hostname))
  ) {
    throw new ModelCallError('The AI provider URL must be a public HTTPS endpoint or local HTTP endpoint without embedded credentials, query strings, or fragments.', undefined, 'configuration')
  }
  const basePath = endpoint.pathname.replace(/\/+$/, '')
  const modelsPath = '/models'
  endpoint.pathname = basePath === modelsPath || basePath.endsWith(modelsPath)
    ? basePath
    : `${basePath}${modelsPath}`
  return endpoint.toString()
}

export function parseModelsList(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  let items: unknown[] = []
  if (Array.isArray(data)) {
    items = data
  } else {
    const record = data as Record<string, unknown>
    if (Array.isArray(record['data'])) {
      items = record['data']
    } else if (Array.isArray(record['models'])) {
      items = record['models']
    }
  }
  const result: string[] = []
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) {
      result.push(item.trim())
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const id = typeof obj['id'] === 'string' ? obj['id'].trim() : (typeof obj['name'] === 'string' ? obj['name'].trim() : '')
      if (id) result.push(id)
    }
  }
  return Array.from(new Set(result))
}

export async function listCustomModels(baseUrl: string, key?: string): Promise<string[]> {
  let endpoint = modelsEndpointFor(baseUrl)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (key && key.trim()) {
    headers['authorization'] = `Bearer ${key.trim()}`
  }
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000)
    })
    if (response.status === 404 && !endpoint.includes('/v1/')) {
      const v1Endpoint = endpoint.replace(/\/models$/, '/v1/models')
      const retry = await fetch(v1Endpoint, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000)
      }).catch(() => null)
      if (retry && retry.ok) {
        response = retry
      }
    }
  } catch {
    throw new ModelCallError('The AI service is unreachable.', undefined, 'network')
  }
  if (!response.ok) {
    throw new ModelCallError(`The AI service returned status ${response.status}.`, response.status, 'response')
  }
  const json: unknown = await response.json().catch(() => {
    throw new ModelCallError('The AI service returned invalid JSON.', undefined, 'parse')
  })
  return parseModelsList(json)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function contentFromChoice(choice: unknown): string {
  if (!isRecord(choice)) return ''
  const delta = isRecord(choice['delta']) ? choice['delta'] : undefined
  const message = isRecord(choice['message']) ? choice['message'] : undefined
  return stringValue(delta?.['content']) || stringValue(message?.['content']) || stringValue(choice['text'])
}

function normalizeMessages(messages: unknown): ModelCallMessage[] {
  if (!Array.isArray(messages)) {
    throw new ModelCallError('The AI request messages must be an array.', undefined, 'validation')
  }
  return messages.map((message, index) => {
    if (!isRecord(message)) {
      throw new ModelCallError(`The AI request message at index ${index} is invalid.`, undefined, 'validation')
    }
    const role = message['role']
    const content = message['content']
    if ((role !== 'system' && role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      throw new ModelCallError(`The AI request message at index ${index} must contain a supported role and string content.`, undefined, 'validation')
    }
    return { role, content }
  })
}

/** Parse OpenAI-compatible SSE deltas, while accepting a normal JSON response. */
function parseJsonResponse(raw: string): string {
  let body: unknown
  try {
    body = JSON.parse(raw) as unknown
  } catch {
    throw new ModelCallError('The AI service returned invalid JSON.', undefined, 'parse')
  }
  if (!isRecord(body) || !Array.isArray(body['choices'])) return ''
  return body['choices'].map(contentFromChoice).join('')
}

export function parseModelResponse(raw: string, contentType = ''): string {
  if (!contentType.toLowerCase().includes('text/event-stream') && !/^\s*data:/m.test(raw)) {
    return parseJsonResponse(raw)
  }

  let content = ''
  let dataLines: string[] = []
  const consumeEvent = (): void => {
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data || data === '[DONE]') return
    let event: unknown
    try {
      event = JSON.parse(data) as unknown
    } catch {
      throw new ModelCallError('The AI service returned invalid SSE JSON.', undefined, 'parse')
    }
    if (isRecord(event) && Array.isArray(event['choices'])) {
      content += event['choices'].map(contentFromChoice).join('')
    }
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      consumeEvent()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (dataLines.length) consumeEvent()
  return content
}

/** Google AI Studio credential (e.g. AIza... or AQ....). */
export function isGoogleKey(key: string): boolean {
  return /^(?:AQ\.|AIza)/i.test(key.trim())
}

/**
 * Make one request against the configured provider ('google' or 'custom').
 * An opaque AQ.* or AIza* key (or provider='google') dispatches to Google's
 * generateContent endpoint (key in the x-goog-api-key header, never logged);
 * provider='custom' uses the OpenAI-compatible Bearer endpoint.
 */
export async function callModel(settings: AiSettings, messages: unknown): Promise<string> {
  const effective = effectiveSettings(settings)
  if (effective.provider === 'google' || isGoogleKey(effective.key)) {
    if (!effective.key) throw new ModelCallError('No API key is set.', undefined, 'configuration')
    return callGoogle(effective.key, effective.model, messages)
  }

  const endpoint = endpointFor(effective.baseUrl)
  const isLocal = isLocalhost(new URL(endpoint).hostname)
  if (!effective.key && !isLocal) throw new ModelCallError('No API key is set.', undefined, 'configuration')

  const normalizedMessages = normalizeMessages(messages)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (effective.key) {
    headers['authorization'] = `Bearer ${effective.key}`
  }
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: effective.model,
        messages: normalizedMessages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: true
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch {
    throw new ModelCallError('The AI service is unreachable.', undefined, 'network')
  }

  if (!response.ok) {
    throw new ModelCallError(`The AI service returned status ${response.status}.`, response.status, 'response')
  }

  const raw = await response.text().catch(() => {
    throw new ModelCallError('The AI service returned an unreadable reply.', undefined, 'response')
  })
  const content = parseModelResponse(raw, response.headers.get('content-type') ?? '')
  if (!content.trim()) throw new ModelCallError('The AI service returned an empty reply.', undefined, 'response')
  return content
}

/** Google AI Studio generateContent call for Google keys. */
async function callGoogle(key: string, model: string, messages: unknown): Promise<string> {
  const normalizedMessages = normalizeMessages(messages)
  const name = (model || GOOGLE_DEFAULT_MODEL).trim() || GOOGLE_DEFAULT_MODEL
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent`
  const contents = normalizedMessages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  const system = normalizedMessages.find((m) => m.role === 'system')
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key.trim() },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system.content }] } } : {}),
        contents: contents.length ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch {
    throw new ModelCallError('The AI service is unreachable.', undefined, 'network')
  }
  if (!response.ok) {
    throw new ModelCallError(`The AI service returned status ${response.status}.`, response.status, 'response')
  }
  let body: unknown
  try {
    body = (await response.json()) as unknown
  } catch {
    throw new ModelCallError('The AI service returned an unreadable reply.', undefined, 'response')
  }
  const out: string[] = []
  const root = body as { candidates?: unknown }
  if (Array.isArray(root.candidates)) {
    for (const cand of root.candidates as Array<{ content?: { parts?: Array<{ text?: unknown }> } }>) {
      for (const part of cand.content?.parts ?? []) {
        if (typeof part.text === 'string') out.push(part.text)
      }
    }
  }
  const content = out.join('').trim()
  if (!content) throw new ModelCallError('The AI service returned an empty reply.', undefined, 'response')
  return content
}