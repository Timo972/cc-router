const shim = new URL("./telemetry-consent-fs-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "fs" && context.parentURL?.includes("/src/config/telemetry-state.ts")) {
    return { url: shim, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
