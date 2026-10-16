// Client networking: transports to the authoritative match (online WebSocket server or the
// single-player Web Worker). Both speak src/shared/protocol.ts.

export type { Transport, TransportKind } from './transport';
export { BaseTransport, isServerMessage } from './transport';
export { WsTransport, defaultWsUrl, WS_CONNECT_TIMEOUT_MS } from './WsTransport';
export { LocalTransport } from './LocalTransport';
