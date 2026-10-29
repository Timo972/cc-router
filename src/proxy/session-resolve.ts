import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { normalizeSessionId, type SessionBindingView } from "./session-router.js";

export type SessionResolveProvider = "anthropic" | "openai";

export interface SessionResolveRequest {
  provider: SessionResolveProvider;
  sessionId: string;
}

export interface SessionResolver {
  resolve(sessionHeader: unknown): SessionBindingView | undefined;
}

export interface SessionResolveRouters {
  anthropicRouter: SessionResolver;
  openAIRouter: SessionResolver;
}

export type SessionResolveResult =
  | {
    status: 200;
    body: SessionBindingView & { provider: SessionResolveProvider };
  }
  | {
    status: 404;
    body: { error: "Session binding not found" };
  };

export type SessionResolveParseResult =
  | { ok: true; request: SessionResolveRequest }
  | { ok: false; error: "Invalid session resolve request" };

export function parseSessionResolveRequest(body: unknown): SessionResolveParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidRequest();
  }

  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("provider") || !keys.includes("sessionId")) {
    return invalidRequest();
  }

  const candidate = body as { provider?: unknown; sessionId?: unknown };
  if (candidate.provider !== "anthropic" && candidate.provider !== "openai") {
    return invalidRequest();
  }

  const sessionId = normalizeSessionId(candidate.sessionId);
  if (!sessionId) return invalidRequest();

  return {
    ok: true,
    request: {
      provider: candidate.provider,
      sessionId,
    },
  };
}

export function resolveSessionBinding(
  request: SessionResolveRequest,
  routers: SessionResolveRouters,
): SessionResolveResult {
  const router = request.provider === "anthropic"
    ? routers.anthropicRouter
    : routers.openAIRouter;
  const binding = router.resolve(request.sessionId);

  if (!binding) {
    return {
      status: 404,
      body: { error: "Session binding not found" },
    };
  }

  return {
    status: 200,
    body: {
      accountId: binding.accountId,
      provider: request.provider,
      lastSeenAt: binding.lastSeenAt,
    },
  };
}

export function registerSessionResolveRoute(
  app: Express,
  routers: SessionResolveRouters,
): void {
  const route = express.Router();
  route.use(express.json({ limit: "1kb", strict: true }));
  route.post("/", (req, res) => {
    const parsed = parseSessionResolveRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const result = resolveSessionBinding(parsed.request, routers);
    res.status(result.status).json(result.body);
  });
  route.use((
    _error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    res.status(400).json({ error: "Invalid session resolve request" });
  });

  app.use("/cc-router/sessions/resolve", route);
}

function invalidRequest(): SessionResolveParseResult {
  return {
    ok: false,
    error: "Invalid session resolve request",
  };
}
