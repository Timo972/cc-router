import http from "node:http";
import https from "node:https";
import net from "node:net";

try { await fetch("https://example.invalid/caught-fetch"); } catch {}
try { await fetch("not a URL"); } catch {}
try { http.request("http://example.invalid/caught-http"); } catch {}
try { https.request("https://example.invalid/caught-https"); } catch {}
try { http.get("http://example.invalid/caught-http-get"); } catch {}
try { https.get("https://example.invalid/caught-https-get"); } catch {}
try { https.get("https://eu.i.posthog.com/not-approved"); } catch {}
try { new net.Socket().connect({ host: "203.0.113.1", port: 443 }); } catch {}
try { new net.Socket().connect({ host: "2001:db8::1", port: 443 }); } catch {}
