import type { Command } from "commander";
import { existsSync, openSync, readSync, closeSync, statSync, watch } from "fs";
import chalk from "chalk";
import { LOG_PATH } from "../config/paths.js";

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("View proxy logs")
    .option("--lines <n>", "Number of lines to show (default: 50)", "50")
    .option("-f, --follow", "Follow log output in real time")
    .action(async (opts: { lines: string; follow?: boolean }) => {
      if (!existsSync(LOG_PATH)) {
        console.log(chalk.yellow("No log file found."));
        console.log(chalk.gray(`  Expected: ${LOG_PATH}`));
        console.log(chalk.gray("  Logs are created when running in background mode."));
        console.log(chalk.gray("  Foreground mode prints directly to this terminal.\n"));
        return;
      }

      const numLines = parseInt(opts.lines, 10) || 50;

      if (opts.follow) {
        await tailFollow(numLines);
      } else {
        tailStatic(numLines);
      }
    });
}

/** Print last N lines of the log file using byte-based seeking. */
function tailStatic(n: number): void {
  if (!existsSync(LOG_PATH)) {
    console.log(chalk.gray("No log file found. Is the daemon running?"));
    return;
  }

  const stats = statSync(LOG_PATH);
  if (stats.size === 0) {
    console.log(chalk.gray("Log file is empty."));
    return;
  }

  // Read last chunk (up to 64KB should be enough for most tail operations)
  const CHUNK = Math.min(stats.size, 64 * 1024);
  const buf = Buffer.alloc(CHUNK);
  const fd = openSync(LOG_PATH, "r");
  readSync(fd, buf, 0, CHUNK, stats.size - CHUNK);
  closeSync(fd);

  const text = buf.toString("utf-8");
  const lines = text.split("\n");
  // Remove first potentially partial line if we didn't read from start
  if (CHUNK < stats.size) lines.shift();
  const tail = lines.slice(-n).join("\n");
  if (tail) process.stdout.write(tail + "\n");
}

/** Stream log file and print new lines as they appear. */
async function tailFollow(initialLines: number): Promise<void> {
  // Show initial tail
  tailStatic(initialLines);

  console.log(chalk.gray("\n── Following log output (Ctrl+C to stop) ──\n"));

  if (!existsSync(LOG_PATH)) {
    console.log(chalk.gray("Waiting for log file..."));
  }

  let bytePosition = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;

  const watcher = watch(LOG_PATH, () => {
    try {
      const currentSize = statSync(LOG_PATH).size;
      if (currentSize > bytePosition) {
        const buf = Buffer.alloc(currentSize - bytePosition);
        const fd = openSync(LOG_PATH, "r");
        readSync(fd, buf, 0, buf.length, bytePosition);
        closeSync(fd);
        process.stdout.write(buf.toString("utf-8"));
        bytePosition = currentSize;
      } else if (currentSize < bytePosition) {
        // File was truncated/rotated
        bytePosition = 0;
      }
    } catch { /* file may have been removed */ }
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });

  await new Promise(() => {}); // never resolves
}
