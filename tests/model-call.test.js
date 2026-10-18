import test from 'node:test'
import assert from 'node:assert/strict'
import { callModel, parseModelResponse, listCustomModels, parseModelsList, modelsEndpointFor } from '../src/main/modelCall.ts'
import { chat } from '../src/main/ai.ts'

const settings = { baseUrl: 'https://provider.example/v1', key: 'test-secret', model: 'official-model' }

function jsonResponse(body, contentType = 'application/json') {
  return new Response(JSON.stringify(body), { headers: { 'content-type': contentType } })
}

function statusResponse(status, detail = 'provider-secret-detail') {
  return new Response(JSON.stringify({ error: { message: detail } }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('safe model-call adapter sends configured endpoint and main-process Bearer key', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init }
    return jsonResponse({ choices: [{ message: { content: 'Hello from provider' } }] })
  }
  try {
    const result = await callModel(settings, [{ role: 'user', content: 'Hello', reasoning_content: 'do not forward', tool_calls: [] }])
    assert.equal(result, 'Hello from provider')
    assert.equal(request.input, 'https://provider.example/v1/chat/completions')
    assert.deepEqual(Object.keys(request.init.headers).sort(), ['authorization', 'content-type'])
    assert.equal(request.init.headers.authorization, 'Bearer test-secret')
    const body = JSON.parse(request.init.body)
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }])
    assert.equal(body.model, 'official-model')
    assert.equal(body.stream, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('safe model-call adapter parses OpenAI-compatible SSE deltas', () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  assert.equal(parseModelResponse(raw, 'text/event-stream'), 'Hello')
})

test('safe model-call adapter rejects missing keys and unsafe endpoints', async () => {
  await assert.rejects(
    callModel({ ...settings, key: '' }, [{ role: 'user', content: 'Hello' }]),
    /No API key/
  )
  await assert.rejects(
    callModel({ ...settings, baseUrl: 'http://insecure-remote.example/v1' }, [{ role: 'user', content: 'Hello' }]),
    /public HTTPS endpoint/
  )
})

test('safe model-call adapter rejects malformed message arrays before fetch', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    return jsonResponse({ choices: [{ message: { content: 'unexpected' } }] })
  }
  try {
    await assert.rejects(callModel(settings, 'not-an-array'), /messages must be an array/)
    await assert.rejects(callModel(settings, [{ role: 'user' }]), /message at index 0/)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('safe model-call adapter rejects query, fragment, and private IPv4/IPv6 endpoints', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('endpoint validation should stop before fetch')
  }
  try {
    for (const baseUrl of [
      'https://provider.example/v1?tenant=one',
      'https://provider.example/v1#fragment',
      'https://169.254.169.254/v1',
      'https://10.0.0.1/v1',
      'https://[fc00::1]/v1',
      'https://[::ffff:169.254.169.254]/v1'
    ]) {
      await assert.rejects(
        callModel({ ...settings, baseUrl }, [{ role: 'user', content: 'Hello' }]),
        /public HTTPS endpoint/
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ai chat maps invalid URL, rate-limit, and server errors without provider details', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => statusResponse(429)
    await assert.rejects(chat(settings, [{ role: 'user', content: 'Hello' }]), (error) => {
      assert.equal(error.userMessage, 'The AI service is rate limited. Wait a moment and try again.')
      assert.equal(error.message, error.userMessage)
      assert.doesNotMatch(error.message, /provider-secret-detail/)
      return true
    })

    globalThis.fetch = async () => statusResponse(503)
    await assert.rejects(chat(settings, [{ role: 'user', content: 'Hello' }]), (error) => {
      assert.equal(error.userMessage, 'The AI service is temporarily unavailable. Try again later.')
      assert.equal(error.message, error.userMessage)
      assert.doesNotMatch(error.message, /provider-secret-detail/)
      return true
    })

    globalThis.fetch = async () => statusResponse(200)
    await assert.rejects(chat({ ...settings, baseUrl: 'http://insecure-remote.example/v1' }, [{ role: 'user', content: 'Hello' }]), (error) => {
      assert.equal(error.userMessage, 'The AI provider URL is invalid. Use a public HTTPS or local OpenAI-compatible endpoint without credentials, query strings, or fragments.')
      assert.equal(error.message, error.userMessage)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('provider google dispatches to generateContent with x-goog-api-key header and system instruction', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init }
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello from Google Gemini' }]
          }
        }
      ]
    })
  }
  try {
    const result = await callModel(
      { provider: 'google', baseUrl: '', key: 'AIzaSyDummyKey', model: 'gemini-3.8-flash' },
      [
        { role: 'system', content: 'You are ARA Assistant.' },
        { role: 'user', content: 'What is a p-value?' }
      ]
    )
    assert.equal(result, 'Hello from Google Gemini')
    assert.equal(request.input, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
    assert.equal(request.init.headers['x-goog-api-key'], 'AIzaSyDummyKey')
    const body = JSON.parse(request.init.body)
    assert.equal(body.systemInstruction.parts[0].text, 'You are ARA Assistant.')
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'What is a p-value?' }] }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('provider custom dispatches with Bearer auth and OpenAI-compatible format', async () => {
  const originalFetch = globalThis.fetch
  let request
  const sse = (content) =>
    new Response(
      [`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`, '', 'data: [DONE]', ''].join('\n'),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init }
    return sse('Custom endpoint response')
  }
  try {
    const result = await callModel(
      { provider: 'custom', baseUrl: 'https://api.openai.com/v1', key: 'sk-custom-secret', model: 'gpt-4o-mini' },
      [{ role: 'user', content: 'Hi' }]
    )
    assert.equal(result, 'Custom endpoint response')
    assert.equal(request.input, 'https://api.openai.com/v1/chat/completions')
    assert.equal(request.init.headers.authorization, 'Bearer sk-custom-secret')
    const body = JSON.parse(request.init.body)
    assert.equal(body.model, 'gpt-4o-mini')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('safe model-call adapter allows localhost custom endpoints without requiring an API key', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init }
    return jsonResponse({ choices: [{ message: { content: 'Local response' } }] })
  }
  try {
    const result = await callModel(
      { provider: 'custom', baseUrl: 'http://localhost:11434/v1', key: '', model: 'llama3' },
      [{ role: 'user', content: 'Hi' }]
    )
    assert.equal(result, 'Local response')
    assert.equal(request.input, 'http://localhost:11434/v1/chat/completions')
    assert.equal(request.init.headers['authorization'], undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('modelsEndpointFor constructs valid /models path and validates URL', () => {
  assert.equal(modelsEndpointFor('https://api.openai.com/v1'), 'https://api.openai.com/v1/models')
  assert.equal(modelsEndpointFor('http://localhost:11434/v1/'), 'http://localhost:11434/v1/models')
  assert.equal(modelsEndpointFor('http://localhost:1234/models'), 'http://localhost:1234/models')
})

test('parseModelsList extracts model IDs from standard OpenAI and Ollama shapes', () => {
  const openAiShape = {
    object: 'list',
    data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }]
  }
  assert.deepEqual(parseModelsList(openAiShape), ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small'])

  const ollamaShape = {
    models: [{ name: 'llama3.2:latest' }, { name: 'mistral:latest' }]
  }
  assert.deepEqual(parseModelsList(ollamaShape), ['llama3.2:latest', 'mistral:latest'])

  const flatArray = ['model-a', 'model-b']
  assert.deepEqual(parseModelsList(flatArray), ['model-a', 'model-b'])
})

test('listCustomModels fetches and parses model IDs with auth header', async () => {
  const originalFetch = globalThis.fetch
  let capturedInput
  let capturedHeaders
  globalThis.fetch = async (input, init) => {
    capturedInput = String(input)
    capturedHeaders = init?.headers
    return jsonResponse({
      data: [{ id: 'qwen2.5-coder' }, { id: 'deepseek-r1' }]
    })
  }
  try {
    const models = await listCustomModels('http://localhost:11434/v1', 'my-key')
    assert.deepEqual(models, ['qwen2.5-coder', 'deepseek-r1'])
    assert.equal(capturedInput, 'http://localhost:11434/v1/models')
    assert.equal(capturedHeaders.authorization, 'Bearer my-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})

