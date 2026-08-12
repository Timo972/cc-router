import type { ServerResponse } from "node:http";
import type { Request, RequestHandler } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { Options } from "http-proxy-middleware";

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
        const stripPropagationHeaders = (): void => {
          proxyRequest.removeHeader("traceparent");
          proxyRequest.removeHeader("tracestate");
          proxyRequest.removeHeader("baggage");
        };
        stripPropagationHeaders();
        proxyRequest.once("response", () => {
          proxyRequest.setTimeout(0);
          request.socket.setTimeout(0);
        });
        configuredProxyRequest?.(proxyRequest, request, response, proxyOptions);
        stripPropagationHeaders();
      },
    },
  });
}
