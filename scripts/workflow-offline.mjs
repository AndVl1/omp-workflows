import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';

function offline() {
  const error = new Error('Network access is forbidden in deterministic workflow scenarios');
  error.code = 'WORKFLOW_SCENARIO_NETWORK_FORBIDDEN';
  throw error;
}

// Process fixtures use files/IPC barriers, not sockets. Install before production
// modules load, including in inherited node child processes.
net.connect = net.createConnection = net.Socket.prototype.connect = offline;
net.Server.prototype.listen = offline;
tls.connect = offline;
http.request = http.get = https.request = https.get = offline;
dgram.createSocket = offline;
dns.lookup = dns.resolve = offline;
dns.promises.lookup = dns.promises.resolve = offline;
globalThis.fetch = async () => offline();
syncBuiltinESMExports();
