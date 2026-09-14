import type { ServerResponse } from "node:http";
import type { Request, RequestHandler } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { Options } from "http-proxy-middleware";

/**
 * Inbound trace context is stripped rather than forwarded, by every Anthropic
 * relay: telemetry never joins a client's distributed trace, and a client's
 * context headers must not reach the upstream provider through this proxy.
 */
export const TRACE_CONTEXT_HEADERS = ["traceparent", "tracestate", "baggage"] as const;

export interface AnthropicProxyOptions {
  target: string;
  timeoutMs: number;
  on: NonNullable<Options<Request, ServerResponse>["on"]>;
}

/**
 * Construct the Anthropic transport with http-proxy-middleware's native
 * response piping. In particular, this deliberately does not self-handle,
 * buffer, transform, or synthesize any response bytes.
 */
export function createAnthropicProxy(options: AnthropicProxyOptions): RequestHandler {
  const configuredProxyRequest = options.on.proxyReq;
  return createProxyMiddleware<Request, ServerResponse>({
    target: options.target,
    changeOrigin: true,
    pathRewrite: path => `/v1${path}`,
    proxyTimeout: options.timeoutMs,
    timeout: options.timeoutMs,
    on: {
      ...options.on,
      proxyReq: (proxyRequest, request, response, proxyOptions) => {
        // Telemetry never joins a distributed trace: a client's context headers
        // must not reach the upstream provider through this proxy.
        for (const header of TRACE_CONTEXT_HEADERS) proxyRequest.removeHeader(header);
        proxyRequest.once("response", () => {
          proxyRequest.setTimeout(0);
          request.socket.setTimeout(0);
        });
        configuredProxyRequest?.(proxyRequest, request, response, proxyOptions);
      },
    },
  });
}
