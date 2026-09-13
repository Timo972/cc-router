import type { OpenAISubscriptionAccount } from "./token-refresher.js";

export type CodexResetCode = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";
export interface CodexResetResult { code: CodexResetCode }

export async function consumeCodexResetCredit(
  account: Pick<OpenAISubscriptionAccount, "accessToken">,
  redeemRequestId: string,
): Promise<CodexResetResult> {
  // Contract: openai/codex 1715e55076737158ba61d43158ede504de6d4ce1,
  // codex-rs/backend-client/src/client/rate_limit_resets.rs and types.rs.
  // Never retry a spend with a fresh ID: a lost response may have consumed it.
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
      method: "POST",
      headers: {
        authorization: `Bearer ${account.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ redeem_request_id: redeemRequestId }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (response.ok) {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "code" in body) {
        const code = body.code;
        if (code === "reset" || code === "nothing_to_reset" || code === "no_credit" || code === "already_redeemed") {
          return { code };
        }
      }
    }
  } catch {
    // Do not relay upstream bodies, credentials, or network error details.
  }
  throw new Error("Reset outcome unknown; retry with the same redemption ID");
}
