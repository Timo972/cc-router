try {
  await fetch("https://eu.i.posthog.com/batch/", {
    method: "POST",
    body: "{}",
    signal: AbortSignal.timeout(50),
  });
} catch {
  // The held fixture deliberately exceeds the request deadline.
}

// Undici may replace a transport after the authorized request aborts. Give the
// transport lifecycle time to run before the child exits.
await new Promise(resolve => setTimeout(resolve, 250));
process.stdout.write("authorized request settled\n");
