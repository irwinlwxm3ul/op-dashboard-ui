// Translation of UI error codes (lobby / protocol codes and client-side network codes).

import { errorText, t } from '../i18n';
import type { LobbyErrorCode } from '../../shared/protocol';
import type { UiErrorCode } from './contracts';

const LOBBY_CODES: ReadonlySet<string> = new Set<LobbyErrorCode>([
  'lobby.notFound', 'lobby.full', 'lobby.inGame', 'lobby.notHost', 'lobby.teamFull', 'lobby.notReady',
  'lobby.badSettings', 'lobby.nameInvalid', 'net.rateLimited', 'net.badMessage', 'net.versionMismatch', 'net.kicked',
]);

export function uiErrorText(code: UiErrorCode | string): string {
  switch (code) {
    case 'net.disconnected': return t('ui.error.disconnected');
    case 'net.connectFailed': return t('ui.error.connectFailed');
    case 'net.serverOffline': return t('ui.error.serverOffline');
    default:
      return LOBBY_CODES.has(code) ? errorText(code as LobbyErrorCode) : t('ui.error.generic');
  }
}

/** Codes that mean the multiplayer connection is gone. */
export function isConnectionLoss(code: UiErrorCode | string): boolean {
  return code === 'net.disconnected' || code === 'net.connectFailed' || code === 'net.serverOffline'
    || code === 'net.kicked' || code === 'net.versionMismatch';
}
