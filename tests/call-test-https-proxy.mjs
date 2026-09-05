import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";

export async function startCallTestGateways() {
  const directory = mkdtempSync(join(tmpdir(), "call-test-tls-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  if (result.status !== 0) {
    rmSync(directory, { recursive: true });
    throw new Error("Test certificate generation failed");
  }
  const credentials = { key: readFileSync(key), cert: readFileSync(cert) };
  const certificate = new X509Certificate(credentials.cert);
  const spki = createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  rmSync(directory, { recursive: true });
  const servers = [];
  const sockets = new Set();
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  };
  try {
    for (const [index, host] of ["app-a", "app-b"].entries()) {
      const server = https.createServer(credentials, (request, response) => {
        const upstream = http.request(
          {
            hostname: host,
            port: 8080,
            method: request.method,
            path: request.url,
            headers: request.headers,
          },
          (remote) => {
            response.writeHead(remote.statusCode, remote.headers);
            remote.pipe(response);
          },
        );
        upstream.on("error", () => {
          if (!response.headersSent) {
            response.writeHead(502);
            response.end();
          } else response.destroy();
        });
        upstream.on("socket", (socket) => {
          if (!sockets.has(socket)) {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
          }
        });
        response.on("close", () => {
          if (!response.writableEnded) upstream.destroy();
        });
        request.on("error", () => upstream.destroy());
        request.pipe(upstream);
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (request, socket, head) => {
        const upstream = net.connect(8080, host, () => {
          const headers = request.rawHeaders.reduce(
            (lines, value, index, all) =>
              index % 2 ? lines : [...lines, `${value}: ${all[index + 1]}`],
            [],
          );
          upstream.write(
            `${request.method} ${request.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`,
          );
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        socket.on("error", () => upstream.destroy());
        socket.on("close", () => upstream.destroy());
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(8443 + index, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
  } catch {
    await stop();
    throw new Error("Test HTTPS gateway startup failed");
  }
  return { spki, stop };
}
