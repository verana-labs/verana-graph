// spec defines no error contract (verana-spec issue filed); this shape is our documented extension
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_CURSOR'
  | 'NOT_FOUND'
  | 'UNKNOWN_FILTER_FIELD'
  | 'UNSUPPORTED_OPERATOR'

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }

  get httpStatus(): number {
    switch (this.code) {
      case 'NOT_FOUND':
        return 404
      case 'UNKNOWN_FILTER_FIELD':
      case 'UNSUPPORTED_OPERATOR':
        return 422
      default:
        return 400
    }
  }

  toBody(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } }
  }
}
