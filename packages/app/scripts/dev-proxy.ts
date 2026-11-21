/**
 * Shared local reverse proxy: http://<topic>.kwazat.localhost:4000 -> 127.0.0.1:<port of that
 * worktree's dev server>. Routes are read from the registry (scripts/dev-lib.ts) on every
 * request, so servers can come and go; a route whose process is dead is ignored and removed.
 * Started on demand by `pnpm app` (scripts/dev.ts), detached, and shared by every worktree.
 */
import http from "node:http";
import net from "node:net";
import { DOMAIN, liveRoutes, PROXY_PORT, readRoute, urlFor } from "./dev-lib.ts";

const topicOf = (host: string | undefined): string | null => {
  const name = (host ?? "").split(":")[0]!.toLowerCase();
  return name.endsWith(`.${DOMAIN}`) ? name.slice(0, -DOMAIN.length - 1) : null;
};

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: http.ServerResponse, status: number, title: string): void {
  const items = liveRoutes()
    .map((r) => `<li><a href="${urlFor(r.topic)}">${escape(urlFor(r.topic))}</a> <small>${escape(r.root)}</small></li>`)
    .join("");
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Kwazat dev</title><body style="font:16px system-ui;margin:2rem"><h1>${escape(title)}</h1><p>Running dev servers:</p><ul>${items || "<li>none</li>"}</ul>`);
}

const server = http.createServer((req, res) => {
  const topic = topicOf(req.headers.host);
  const route = topic ? readRoute(topic) : null;
  if (!route) return page(res, topic ? 502 : 200, topic ? `No dev server for “${topic}”` : "Kwazat dev servers");
  const upstream = http.request(
    { host: "127.0.0.1", port: route.port, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => (res.headersSent ? res.destroy() : page(res, 502, `The dev server for “${topic}” does not answer`)));
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});

// WebSockets (Next's hot reload).
server.on("upgrade", (req, socket, head) => {
  const topic = topicOf(req.headers.host);
  const route = topic ? readRoute(topic) : null;
  if (!route) return socket.destroy();
  const upstream = net.connect(route.port, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${req.rawHeaders.map((h, i) => (i % 2 ? `${h}\r\n` : `${h}: `)).join("")}\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.on("error", (error) => {
  console.error(`Kwazat dev proxy: ${(error as Error).message}`);
  process.exit(1);
});
server.listen(PROXY_PORT, "127.0.0.1", () => console.log(`Kwazat dev proxy on http://${DOMAIN}:${PROXY_PORT}`));
