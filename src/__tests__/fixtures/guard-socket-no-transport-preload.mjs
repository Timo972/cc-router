import net from "node:net";

net.Socket.prototype.connect = function controlledConnect() {
  return this;
};
