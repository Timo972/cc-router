import type { Command } from "commander";
import chalk from "chalk";
import { getTelemetrySnapshot, updateTelemetryConsent } from "../config/telemetry.js";

export function registerTelemetry(program: Command): void {
  program
    .command("telemetry [action]")
    .description("Manage privacy-safe telemetry: on, off, status (default: status; fresh installs: on)")
    .action(async (action?: string) => {
      const resolved = action ?? "status";

      if (resolved === "status") {
        showStatus();
        return;
      }

      if (resolved === "on") {
        const state = updateTelemetryConsent(true);
        console.log(chalk.green("Telemetry enabled for future daemon starts."));
        console.log(chalk.dim("Restart a daemon that started with telemetry disabled to begin sending telemetry."));
        console.log(chalk.dim(`Install ID: ${state.installId}`));
        return;
      }

      if (resolved === "off") {
        // Do not beacon on opt-out: an explicit "turn it off" must not send data.
        updateTelemetryConsent(false);
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
  console.log(chalk.dim("  What we send:  sampled traces, safe diagnostics, lifecycle events, sanitized exceptions"));
  console.log(chalk.dim("  What we DON'T: tokens, prompts/content, account/session IDs, raw errors, URLs, headers"));
  console.log(chalk.dim("  Network note:   PostHog EU sees the HTTPS source IP; it is not added to the payload"));
  console.log(chalk.dim("  Identity:       random install pseudonym; no Person profile or GeoIP enrichment"));
  console.log(chalk.dim("  Source code:   src/telemetry/"));
  console.log(chalk.dim("  Inventory:     docs/telemetry.md"));
  console.log(chalk.dim("  Default:       on for new installs"));
  console.log();
  console.log(chalk.dim("  Disable:  cc-router telemetry off"));
  console.log(chalk.dim("  Or set:   DO_NOT_TRACK=1  |  CC_ROUTER_TELEMETRY=0"));
}
