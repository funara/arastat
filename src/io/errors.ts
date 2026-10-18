/**
 * Typed IO error: `{code, userMessage, detail}` (§4-shaped like seam errors,
 * but with string codes - `'sav-uncompressed'`, `'io-empty'`, ...).
 * `userMessage` copy rules: sentence case, no exclamation points, names the
 * recovery.
 */
export class IoError extends Error {
  code: string
  userMessage: string
  detail?: string

  constructor(code: string, userMessage: string, detail?: string) {
    super(userMessage)
    this.name = 'IoError'
    this.code = code
    this.userMessage = userMessage
    this.detail = detail
  }
}
