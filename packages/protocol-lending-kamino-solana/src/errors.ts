/** A refusal or failure inside the Kamino module; `code` carries Kamino's API error code when there is one. */
export class KaminoError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'KaminoError'
    this.code = code
  }
}
