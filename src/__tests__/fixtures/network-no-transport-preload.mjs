import http from "node:http";
import https from "node:https";
import net from "node:net";

const reached = () => { throw new Error("network transport reached before guard rejection"); };
http.request = reached;
http.get = reached;
https.request = reached;
https.get = reached;
net.Socket.prototype.connect = reached;
