const colors = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

function getCallerInfo(): string {
  const stack = new Error().stack;
  if (!stack) return "unknown:0";

  const lines = stack.split("\n");
  // Skip: Error line, getCallerInfo, and the log function itself
  const callerLine = lines[3];
  if (!callerLine) return "unknown:0";

  // Match file:line:column pattern (works for Deno/Node stack traces)
  const match = callerLine.match(/\((.+):(\d+):(\d+)\)/) ||
    callerLine.match(/at (.+):(\d+):(\d+)/);

  if (match) {
    let filePath = match[1];
    const lineNum = match[2];

    // Remove file:// protocol if present
    filePath = filePath.replace(/^file:\/\//, "");

    // Make path relative to workspace root
    const cwd = Deno.cwd();
    if (filePath.startsWith(cwd)) {
      filePath = filePath.slice(cwd.length + 1); // +1 to remove leading slash
    }

    return `${filePath}:${lineNum}`;
  }

  return "unknown:0";
}

function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export const logger = {
  info(message: string): void {
    const caller = getCallerInfo();
    const timestamp = formatTimestamp();
    console.log(
      `${colors.gray}[${timestamp}]${colors.reset} ${colors.cyan}${caller}${colors.reset} ${message}`,
    );
  },

  error(...args: unknown[]): void {
    const caller = getCallerInfo();
    const timestamp = formatTimestamp();
    console.error(
      `${colors.gray}[${timestamp}]${colors.reset} ${colors.red}${caller}${colors.reset} ${colors.red}${
        args.join(" ")
      }${colors.reset}`,
    );
  },

  warn(...args: unknown[]): void {
    const caller = getCallerInfo();
    const timestamp = formatTimestamp();
    console.warn(
      `${colors.gray}[${timestamp}]${colors.reset} ${colors.yellow}${caller}${colors.reset} ${colors.yellow}${
        args.join(" ")
      }${colors.reset}`,
    );
  },

  debug(...args: unknown[]): void {
    const caller = getCallerInfo();
    const timestamp = formatTimestamp();
    console.debug(
      `${colors.gray}[${timestamp}]${colors.reset} ${colors.blue}${caller}${colors.reset} ${colors.gray}${
        args.join(" ")
      }${colors.reset}`,
    );
  },
};
