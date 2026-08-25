import { chmodSync, existsSync, mkdirSync } from "fs";
import { CONFIG_DIR } from "./paths.js";

const SECRET_DIR_MODE = 0o700;

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: SECRET_DIR_MODE });
    return;
  }
  // Tighten an existing dir that may predate this hardening. No-op on Windows.
  try { chmodSync(CONFIG_DIR, SECRET_DIR_MODE); } catch { /* best effort */ }
}
