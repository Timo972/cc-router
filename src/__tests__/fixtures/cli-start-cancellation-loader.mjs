const prompts = new URL("./cli-start-cancellation-prompts.mjs", import.meta.url).href;
const proxyServer = new URL("./cli-start-proxy-marker.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@inquirer/prompts") {
    return { url: prompts, shortCircuit: true };
  }
  if (specifier === "../proxy/server.js" && context.parentURL?.endsWith("/dist/cli/cmd-start.js")) {
    return { url: proxyServer, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
