import http from "node:http";
import https from "node:https";
import net from "node:net";

try { await fetch("https://example.invalid/caught-fetch"); } catch {}
try { http.request("http://example.invalid/caught-http"); } catch {}
try { https.request("https://example.invalid/caught-https"); } catch {}
try { new net.Socket().connect({ host: "example.invalid", port: 443 }); } catch {}
