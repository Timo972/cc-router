import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runPnpm } from "./ci-pnpm.mjs";

export function installPackedArtifact({ repositoryRoot, workRoot, tarball }) {
  const productionRoot = join(workRoot, "production-install");
  const deployOutput = runPnpm([
    "--offline",
    "--config.inject-workspace-packages=true",
    "--filter",
    "@timo972/cc-router",
    "deploy",
    "--prod",
    productionRoot,
  ], repositoryRoot);

  const packageRoot = join(productionRoot, "node_modules", "@timo972", "cc-router");
  mkdirSync(packageRoot, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    tarball,
    "-C",
    packageRoot,
    "--strip-components=1",
  ], { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });

  return {
    productionRoot,
    packageRoot,
    binary: join(packageRoot, "dist", "cli", "bootstrap.js"),
    deployOutput,
  };
}
