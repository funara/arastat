import type { Readable, Writable } from 'node:stream'

/** Engine push message (notification, no JSON-RPC id). */
export interface SeamNotification {
  method: 'analysis/update' | 'analysis/done'
  params: unknown
}

/** JSON-RPC 2.0 error object (§4 error shape). */
export interface SeamError extends Error {
  code: number
  data?: { userMessage?: string; detail?: string }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

/**
 * NDJSON-RPC 2.0 seam client (§4): one UTF-8 JSON object per line.
 * Shared by the Electron main process and tests/seam.test.js - the tests
 * exercise exactly the code the app runs.
 */
export class SeamClient {
  #stdin: Writable
  #pending = new Map<number, Pending>()
  #nextId = 1
  #buf = ''

  constructor(stdin: Writable, stdout: Readable, onNotification: (note: SeamNotification) => void) {
    this.#stdin = stdin
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      this.#buf += chunk
      let nl: number
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, nl)
        this.#buf = this.#buf.slice(nl + 1)
        if (!line.trim()) continue
        this.#dispatch(JSON.parse(line), onNotification)
      }
    })
    stdout.on('close', () => {
      for (const { reject } of this.#pending.values()) reject(new Error('engine stream closed'))
      this.#pending.clear()
    })
  }

  #dispatch(msg: { id?: unknown; result?: unknown; error?: unknown; method?: unknown; params?: unknown }, onNotification: (note: SeamNotification) => void): void {
    if (typeof msg.method === 'string') {
      onNotification({ method: msg.method as SeamNotification['method'], params: msg.params })
      return
    }
    const pending = this.#pending.get(msg.id as number)
    if (!pending) return
    this.#pending.delete(msg.id as number)
    if (msg.error) {
      const e = msg.error as { code?: number; message?: string; data?: { userMessage?: string; detail?: string } }
      const err = new Error(e.message ?? 'engine error') as SeamError
      err.code = e.code ?? -1
      err.data = e.data
      pending.reject(err)
    } else {
      pending.resolve(msg.result)
    }
  }

  /** Send one request; resolves with `result` or rejects with `SeamError`. */
  invoke(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    this.#pending.set(id, { resolve, reject })
    this.#stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return promise
  }
}
