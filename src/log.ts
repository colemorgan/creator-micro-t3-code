export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

const describe = (detail: unknown) =>
  detail === undefined
    ? ""
    : detail instanceof Error
      ? ` ${detail.message}`
      : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;

export function createLogger(level: LogLevel = "info"): Logger {
  const at = LEVELS[level];
  const write = (name: LogLevel) => (message: string, detail?: unknown) => {
    if (LEVELS[name] < at) return;
    const line = `${new Date().toISOString()} ${name.padEnd(5)} ${message}${describe(detail)}`;
    (name === "error" || name === "warn" ? console.error : console.log)(line);
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
