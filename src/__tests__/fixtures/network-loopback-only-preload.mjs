import net, { isIP } from "node:net";

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function loopbackOnlyConnect(...args) {
  const first = args[0];
  const candidate = Array.isArray(first) ? first[0] : first;
  const options = typeof candidate === "object" && candidate !== null ? candidate : undefined;
  const hostname = options?.host ?? options?.hostname ?? (typeof args[1] === "string" ? args[1] : undefined);
  const normalized = String(hostname ?? "").replace(/^\[|\]$/g, "");
  const loopback = isIP(normalized) === 4 ? normalized.startsWith("127.") : normalized === "::1";
  if (!loopback) throw new Error("non-loopback transport reached before guard redirection");
  return Reflect.apply(originalConnect, this, args);
};
