import http from "node:http";
import https from "node:https";
import { get as namedHttpGet, request as namedHttpRequest } from "node:http";
import { get as namedHttpsGet, request as namedHttpsRequest } from "node:https";
import net from "node:net";
import { attemptBlockedNamedImportsLoadedBeforeGuard } from "./network-named-import-before-preload.mjs";

try { await fetch("https://example.invalid/caught-fetch"); } catch {}
try { await fetch("not a URL"); } catch {}
try { http.request("http://example.invalid/caught-http"); } catch {}
try { http.get("http://example.invalid/caught-http-get"); } catch {}
try { https.request({ hostname: "eu.i.posthog.com", method: "POST", path: "/default-not-approved" }); } catch {}
try { https.get({ hostname: "eu.i.posthog.com", method: "POST", path: "/batch/", port: 8443 }); } catch {}
attemptBlockedNamedImportsLoadedBeforeGuard();
try { namedHttpRequest("http://example.invalid/named-after-http-request"); } catch {}
try { namedHttpGet("http://example.invalid/named-after-http-get"); } catch {}
try { namedHttpsRequest({ hostname: "eu.i.posthog.com", method: "POST", path: "/named-after-not-approved" }); } catch {}
try { namedHttpsGet({ hostname: "eu.i.posthog.com", method: "POST", path: "/batch/", port: 9443 }); } catch {}
try { http.request("http://127.0.0.1:43199/arbitrary-loopback"); } catch {}
try { new net.Socket().connect({ host: "203.0.113.1", port: 443 }); } catch {}
try { new net.Socket().connect({ host: "2001:db8::1", port: 443 }); } catch {}
try { new net.Socket().connect({ host: "eu.i.posthog.com", port: 8443 }); } catch {}
try { new net.Socket().connect({ host: "eu.i.posthog.com", port: 443 }); } catch {}
try { new net.Socket().connect({ host: "127.0.0.1", port: 43199 }); } catch {}
