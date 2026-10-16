// Translation of UI error codes (lobby / protocol codes and client-side network codes).

import { errorText } from '../i18n';
import type { UiErrorCode } from './contracts';

/** Message for any error code (unknown codes map to a generic message). */
export function uiErrorText(code: UiErrorCode | string): string {
  return errorText(code);
}

/** Codes that mean the multiplayer connection is gone. */
export function isConnectionLoss(code: UiErrorCode | string): boolean {
  return code === 'net.disconnected' || code === 'net.connectFailed' || code === 'net.serverOffline'
    || code === 'net.kicked' || code === 'net.versionMismatch';
}
