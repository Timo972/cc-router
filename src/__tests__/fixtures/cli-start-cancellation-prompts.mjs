import { appendFileSync } from "node:fs";

function record(value) {
  appendFileSync(process.env.CC_ROUTER_TEST_PROMPT_LOG, `${value}\n`);
}

export async function confirm(options) {
  if (options?.message === "Run the setup wizard now?") {
    record("start.confirm_setup");
    return true;
  }
  throw new Error("unexpected confirm prompt");
}

export async function select(options) {
  if (options?.message === "What do you want to do?") {
    record("setup.mode_server");
    return "server";
  }
  if (options?.message === "How do you want to add the tokens?") {
    record("setup.method_manual");
    return "manual";
  }
  throw new Error("unexpected select prompt");
}

export async function number() {
  record("setup.account_count_one");
  return 1;
}

export async function password() {
  record("setup.cancel_access_token");
  const error = new Error("controlled prompt cancellation");
  error.name = "ExitPromptError";
  throw error;
}

export async function input() {
  throw new Error("unexpected input prompt");
}
