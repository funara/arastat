// AI chat client: configured model-call adapter for Google / Custom providers.
// The API key is used in main only and never crosses the renderer.
import { callModel, ModelCallError } from './modelCall.ts'
import type { AiSettings } from './settings.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class AiError extends Error {
  userMessage: string

  constructor(userMessage: string) {
    super(userMessage)
    this.name = 'AiError'
    this.userMessage = userMessage
  }
}

/** One completion against the configured provider ('google' or 'custom'). */
export async function chat(settings: AiSettings, messages: unknown): Promise<string> {
  try {
    return await callModel(settings, messages)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const modelError = error instanceof ModelCallError ? error : undefined
    const status = modelError?.status
    const userMessage = modelError?.message === 'No API key is set.'
      ? 'No API key is set. Open AI Settings and configure your Google or Custom API key to enable chat.'
      : modelError?.kind === 'configuration'
        ? 'The AI provider URL is invalid. Use a public HTTPS or local OpenAI-compatible endpoint without credentials, query strings, or fragments.'
        : status === 401 || status === 403
          ? 'The AI service rejected the API key. Check your API key in AI Settings.'
          : status === 429
            ? 'The AI service is rate limited. Wait a moment and try again.'
            : status !== undefined && status >= 500 && status < 600
              ? 'The AI service is temporarily unavailable. Try again later.'
              : modelError?.kind === 'validation'
                ? 'The AI request contained invalid messages. Try again.'
                : modelError?.kind === 'network'
                  ? 'The AI service is unreachable. Check your network connection and base URL in AI Settings.'
                  : detail.includes('empty reply')
                    ? 'The AI service returned an empty reply. Try again.'
                    : 'The AI service returned an unreadable reply. Try again.'
    throw new AiError(userMessage)
  }
}
