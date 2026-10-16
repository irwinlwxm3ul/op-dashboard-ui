// Minimal structured console logger for the game server. Disabled loggers are no-ops so tests
// stay quiet; errors are still reported when logging is disabled only if `alwaysErrors` is set.

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function format(level: string, msg: string, fields?: Record<string, unknown>): string {
  let line = `${new Date().toISOString()} [dropzone] ${level} ${msg}`;
  if (fields) {
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      const s = v instanceof Error ? (v.stack ?? v.message) : typeof v === 'string' ? v : JSON.stringify(v);
      line += ` ${k}=${s}`;
    }
  }
  return line;
}

export function createLogger(enabled: boolean): Logger {
  if (!enabled) {
    const noop = (): void => undefined;
    return { info: noop, warn: noop, error: noop };
  }
  return {
    info: (msg, fields) => console.log(format('INFO ', msg, fields)),
    warn: (msg, fields) => console.warn(format('WARN ', msg, fields)),
    error: (msg, fields) => console.error(format('ERROR', msg, fields)),
  };
}
