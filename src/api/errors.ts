// TG-ERR-1: closed code set, HTTP status fixed per code
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_QUERY'
  | 'UNKNOWN_FILTER_FIELD'
  | 'INVALID_CURSOR'
  | 'UNKNOWN_ID'

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }

  get httpStatus(): number {
    return this.code === 'UNKNOWN_ID' ? 404 : 400
  }

  toBody(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } }
  }
}
