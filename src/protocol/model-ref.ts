export type ProviderKind = "anthropic_subscription" | "openai_subscription" | "openai_api_key";

export interface ParsedModelRef {
  provider: ProviderKind;
  publicModel: string;
  upstreamModel: string;
}

export interface ModelRoutingConfig {
  anthropicDefaultModel?: string;
  openAIDefaultModel?: string;
  anthropicAliases?: Record<string, string>;
  openAIAliases?: Record<string, string>;
}

const CLAUDE_ALIASES: Record<string, string> = {
  "claude/sonnet": "claude-sonnet-4-5",
  "claude/opus": "claude-opus-4-1",
};

function cleanModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Unprefixed models that belong to OpenAI anyway.
 *
 * Clients do not all speak this router's `provider/model` convention. The
 * Codex CLI writes the bare slug from its own registry — `model =
 * "gpt-5.6-sol"` in config.toml, or whatever its `/model` picker selects — and
 * an unprefixed name used to fall through to Anthropic, where the Responses
 * ingress answers `501`. No configuration could redirect it either, since
 * `openAIAliases` is only consulted once a name is already prefixed.
 *
 * `gpt-` is unambiguous: no Claude model is named that way, so claiming it
 * costs the Anthropic path nothing. Everything else unprefixed still goes to
 * Anthropic, which is what existing setups rely on.
 */
function isBareOpenAIModel(publicModel: string): boolean {
  return publicModel.toLowerCase().startsWith("gpt-");
}

export function parseModelRef(model: string | undefined, config: ModelRoutingConfig = {}): ParsedModelRef {
  const publicModel = cleanModel(model) ?? cleanModel(config.anthropicDefaultModel) ?? "claude/sonnet";

  if (publicModel.startsWith("openai/") || isBareOpenAIModel(publicModel)) {
    const openAIModel = publicModel.startsWith("openai/")
      ? publicModel.slice("openai/".length)
      : publicModel;
    const defaultOpenAIModel = cleanModel(config.openAIDefaultModel);
    return {
      provider: "openai_subscription",
      publicModel,
      upstreamModel: config.openAIAliases?.[openAIModel]
        ?? (openAIModel === "default" && defaultOpenAIModel ? defaultOpenAIModel : openAIModel),
    };
  }

  if (publicModel.startsWith("anthropic/")) {
    const anthropicModel = publicModel.slice("anthropic/".length);
    return {
      provider: "anthropic_subscription",
      publicModel,
      upstreamModel: config.anthropicAliases?.[publicModel]
        ?? config.anthropicAliases?.[anthropicModel]
        ?? anthropicModel,
    };
  }

  return {
    provider: "anthropic_subscription",
    publicModel,
    upstreamModel: config.anthropicAliases?.[publicModel] ?? CLAUDE_ALIASES[publicModel] ?? publicModel,
  };
}
