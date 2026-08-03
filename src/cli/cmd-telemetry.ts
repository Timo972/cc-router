import type { Command } from "commander";
import chalk from "chalk";
import { getTelemetrySnapshot, loadTelemetryState, writeTelemetryState } from "../config/telemetry.js";

export function registerTelemetry(program: Command): void {
  program
    .command("telemetry [action]")
    .description("Manage anonymous usage analytics: on, off, status (default: status)")
    .action(async (action?: string) => {
      const resolved = action ?? "status";

      if (resolved === "status") {
        showStatus();
        return;
      }

      if (resolved === "on") {
        const state = loadTelemetryState();
        state.enabled = true;
        writeTelemetryState(state);
        console.log(chalk.green("Telemetry enabled for future daemon starts."));
        console.log(chalk.dim("Restart a daemon that started with telemetry disabled to begin sending telemetry."));
        console.log(chalk.dim(`Install ID: ${state.installId}`));
        return;
      }

      if (resolved === "off") {
        // Do not beacon on opt-out: an explicit "turn it off" must not send data.
        const state = loadTelemetryState();
        state.enabled = false;
        writeTelemetryState(state);
        console.log(chalk.yellow("Telemetry disabled. New outbound telemetry stops immediately."));
        console.log(chalk.dim("Re-enable anytime with: cc-router telemetry on"));
        return;
      }

      console.error(chalk.red(`Unknown action "${resolved}". Use: on, off, status`));
      process.exitCode = 1;
    });
}

function showStatus(): void {
  const { state, environmentDisabled, enabled } = getTelemetrySnapshot();

  console.log(chalk.bold("Telemetry"));
  console.log();

  if (environmentDisabled) {
    console.log(`  Status:     ${chalk.yellow("disabled")} (by environment variable)`);
  } else if (state.enabled) {
    console.log(`  Status:     ${chalk.green("enabled")} (persisted)`);
  } else {
    console.log(`  Status:     ${chalk.yellow("disabled")} (persisted)`);
  }

  console.log(`  Active:     ${enabled ? chalk.green("yes") : chalk.yellow("no")}`);
  console.log(`  Install ID: ${chalk.dim(state.installId)}`);
  console.log(`  Since:      ${chalk.dim(state.firstRunAt)}`);
  console.log();
  console.log(chalk.dim("  What we send:  version, OS, locale, lifecycle events (start, heartbeat)"));
  console.log(chalk.dim("  What we DON'T: IPs, tokens, prompts, request content, account names"));
  console.log(chalk.dim("  Source code:   src/utils/telemetry.ts"));
  console.log(chalk.dim("  Default:       on for new installs"));
  console.log();
  console.log(chalk.dim("  Disable:  cc-router telemetry off"));
  console.log(chalk.dim("  Or set:   DO_NOT_TRACK=1  |  CC_ROUTER_TELEMETRY=0"));
}
