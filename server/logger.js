// Minimale structured logger (JSON-lines naar stdout/stderr). Geen dependencies.
import { config } from "./config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function emit(level, msg, fields = {}) {
  if (LEVELS[level] > (LEVELS[config.logLevel] ?? 2)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  error: (msg, f) => emit("error", msg, f),
  warn: (msg, f) => emit("warn", msg, f),
  info: (msg, f) => emit("info", msg, f),
  debug: (msg, f) => emit("debug", msg, f),
};
