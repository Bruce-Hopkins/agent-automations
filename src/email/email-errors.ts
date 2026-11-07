import type { ImapFlowError } from 'imapflow/lib/errors.js';
import type { EmailCredentials } from '../domain/types';

/** Any mailbox problem the user can act on. */
export class EmailError extends Error {}

export class EmailNotConfiguredError extends EmailError {
  constructor(message = 'No mailbox is configured. Set LEAFI_EMAIL_ADDRESS and LEAFI_EMAIL_APP_PASSWORD in the environment.') {
    super(message);
    this.name = 'EmailNotConfiguredError';
  }
}

/**
 * IMAP rejected the login. With Gmail that is nearly always the app password —
 * a stale one, or none at all because 2-Step Verification is off, which hides
 * the app-password page entirely.
 */
export class EmailAuthError extends EmailError {
  constructor(
    message = 'The mailbox rejected the login. With Gmail, check that 2-Step Verification is on and that LEAFI_EMAIL_APP_PASSWORD is a current app password — Google does not accept the account password over IMAP.',
  ) {
    super(message);
    this.name = 'EmailAuthError';
  }
}

export class EmailConnectionError extends EmailError {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConnectionError';
  }
}

export class EmailTimeoutError extends EmailError {
  constructor(message: string) {
    super(message);
    this.name = 'EmailTimeoutError';
  }
}

export class EmailNotFoundError extends EmailError {
  constructor(message: string) {
    super(message);
    this.name = 'EmailNotFoundError';
  }
}

/** Timeout codes ImapFlow raises, plus the socket-level spelling of the same. */
const TIMEOUT_CODES = new Set(['ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEDOUT']);
/** Codes that mean the server could not be reached at all. */
const CONNECTION_CODES = new Set(['NoConnection', 'EConnectionClosed', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET']);

/**
 * Turns anything thrown by ImapFlow into an error whose message names the thing
 * the user has to change. App-password setup fails in a handful of specific,
 * diagnosable ways, and a generic "command failed" wastes the reader's time.
 */
export function toEmailError(error: unknown, credentials: EmailCredentials): EmailError {
  if (error instanceof EmailError) {
    return error;
  }

  const failure = error as ImapFlowError;
  const where = `${credentials.imapHost}:${credentials.imapPort}`;

  if (failure.authenticationFailed === true || failure.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new EmailAuthError();
  }
  if (failure.mailboxMissing === true) {
    return new EmailConnectionError(`The mailbox does not exist on ${where}.`);
  }
  if (typeof failure.code === 'string' && TIMEOUT_CODES.has(failure.code)) {
    return new EmailTimeoutError(`${where} did not respond in time (${failure.code}).`);
  }
  if (typeof failure.code === 'string' && CONNECTION_CODES.has(failure.code)) {
    return new EmailConnectionError(`Could not reach ${where} (${failure.code}).`);
  }
  if (failure.rejectedFrom === 'connect' || failure.rejectedFrom === 'upgrade') {
    return new EmailConnectionError(`Could not connect to ${where}${failure.message ? `: ${failure.message}` : '.'}`);
  }

  return new EmailConnectionError(failure.message || `The IMAP command failed on ${where}.`);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
