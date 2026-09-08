/** 统一错误信封与错误码表(02 §9,评审 I-31)。P12:失败关闭。 */
export const ERROR_CODES = [
  'enroll_token_invalid',
  'enroll_token_expired',
  'enroll_token_used',
  'enroll_token_in_flight',
  'not_team_member',
  'node_revoked',
  'node_suspended',
  'key_epoch_conflict',
  'rate_limited',
  'quota_exceeded',
  'owner_auth_unconfigured',
  'unauthorized',
  'auth_failed',
  'auth_error',
  'csrf_mismatch',
  'bad_request',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: { code: ErrorCode; message: string; retryable?: boolean; details?: Record<string, unknown> };
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number = 400,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  body(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.retryable ? { retryable: true } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}