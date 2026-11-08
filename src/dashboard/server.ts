// Live ceremony dashboard, served by `vault run` on 127.0.0.1 only.
//   GET  /         the page (self-contained, works offline)
//   GET  /events   Server-Sent Events: snapshot | wire | log
//   POST /api/*    propose · sign · cancel · broadcast (header x-vault: 1 required)
import type { VaultApp } from "../vault-app.ts";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { reviewPayment } from "../payment.ts";
import type { PaymentDraft } from "../payment.ts";
import type { WireEvent } from "../tap.ts";

export interface DashboardActions {
  review?: (draft: PaymentDraft) => Promise<Awaited<ReturnType<typeof reviewPayment>>>;
  proposeReviewed?: (proposal: Awaited<ReturnType<typeof reviewPayment>>["proposal"]) => Promise<unknown>;
  broadcast?: (txHex: string) => Promise<string>;
}

const enc = new TextEncoder();
const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const scriptHash = createHash("sha256").update(page.match(/<script>([\s\S]*?)<\/script>/)![1]).digest("base64");

export function startDashboard(app: VaultApp, opts: { port: number; actions?: DashboardActions; network?: string; reviewTtlMs?: number }) {
  const token = randomBytes(32).toString("hex");
  type Review = Awaited<ReturnType<typeof reviewPayment>>;
  const reviews = new Map<string, { draft: PaymentDraft; result: Review; expires: number }>();
  const authorized = (req: Request) => {
    const supplied = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    return /^[0-9a-f]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  };
  const clients = new Set<ReadableStreamDefaultController>();
  const wire: any[] = [];
  const send = (c: ReadableStreamDefaultController, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  const broadcast = (type: string, data: unknown) => { for (const c of clients) send(c, type, data); };

  // Words that must never appear in what relays see.
  const secrets = () => {
    const s = app.signer?.proposal;
    return [
      ...(s?.summary.recipients.map((r) => r.address) ?? []),
      "tsp1q", "sp1q", '"t":"fs.', "binonces", app.cfg.pin.keyId, app.cfg.pin.accessStructureId,
    ].filter((x) => x && x.length > 4);
  };

  const onWire = (w: WireEvent) => {
    const hit = secrets().some((x) => w.content.includes(x));
    const item = {
      dir: w.dir, at: w.at, id: w.id, kind: w.kind, pubkey: w.pubkey, bytes: w.bytes,
      tags: w.tags.map((t) => t[0]).filter((t) => t !== "d"),
      snippet: w.content.slice(0, 160), plaintext: hit,
    };
    wire.push(item);
    if (wire.length > 200) wire.shift();
    broadcast("wire", item);
  };

  let proposingPayment = false;
  let pending = false;
  app.onChange(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      broadcast("snapshot", app.snapshot());
      broadcast("log", app.logLines.slice(-1)[0]);
    }, 40);
  });

  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: {"cache-control":"no-store"} });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    idleTimeout: 0,
    maxRequestBodySize: 131072,
    async fetch(req) {
      const url = new URL(req.url);
      const host = `127.0.0.1:${server.port}`;
      if (req.headers.get("host") !== host || url.host !== host) return json({error:"invalid host"},403);
      const origin = req.headers.get("origin");
      if ((origin && origin !== `http://${host}`) || req.headers.get("sec-fetch-site") === "cross-site") return json({error:"invalid origin"},403);
      if (url.pathname === "/" && req.method === "GET") return new Response(page, { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy":"no-referrer",
        "x-frame-options":"DENY", "x-content-type-options":"nosniff",
        "content-security-policy":`default-src 'self'; script-src 'sha256-${scriptHash}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      } });
      if (!authorized(req)) return json({error:"Open BlackIce using this launch’s authenticated link."},401);
      if (url.pathname === "/events" && req.method === "GET") {
        let ctl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctl = c;
            clients.add(c);
            send(c, "hello", { network: opts.network ?? "signet" });
            send(c, "snapshot", app.snapshot());
            for (const w of wire) send(c, "wire", w);
            for (const l of app.logLines.slice(-80)) send(c, "log", l);
          },
          cancel() { clients.delete(ctl); },
        });
        req.signal.addEventListener("abort", () => clients.delete(ctl));
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "POST" || req.headers.get("x-vault") !== "1") return json({ error: "forbidden" }, 403);
        if (!req.headers.get("content-type")?.startsWith("application/json")) return json({error:"JSON required"},415);
        const raw = await req.text();
        if (raw.length > 131072) return json({error:"request too large"},413);
        let body: any;
        try { body = JSON.parse(raw); } catch { return json({error:"invalid JSON"},400); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return json({error:"invalid request"},400);
        try {
          switch (url.pathname) {
            case "/api/review": {
              if (!opts.actions?.review) throw new Error("only the coordinator prepares payments");
              const draft = structuredClone(body) as PaymentDraft;
              const result = await opts.actions.review(structuredClone(draft));
              // Keep only the most recent review, with a fresh single-use capability.
              reviews.clear();
              const reviewId = randomBytes(32).toString("hex");
              reviews.set(reviewId, {draft, result:structuredClone(result), expires:Date.now()+(opts.reviewTtlMs ?? 300000)});
              return json({reviewId, totals:result.totals});
            }
            case "/api/payment": {
              if (!opts.actions?.proposeReviewed || !opts.actions.review) throw new Error("only the coordinator proposes payments");
              if (Object.keys(body).some(k => k !== "reviewId")) throw new Error("Submit only the reviewed payment ID");
              if (!app.snapshot().deviceReady || !app.snapshot().canPropose) throw new Error("Connect your device and finish or cancel the current payment first");
              if (proposingPayment) throw new Error("A payment is already being prepared");
              const review = reviews.get(body.reviewId);
              if (!review || review.expires <= Date.now()) throw new Error("Payment review expired or was already used; review again");
              reviews.delete(body.reviewId);
              proposingPayment = true;
              try {
                const checked = await opts.actions.review(structuredClone(review.draft));
                if (JSON.stringify(checked) !== JSON.stringify(review.result)) throw new Error("Payment changed since review; review again");
                await opts.actions.proposeReviewed(structuredClone(review.result.proposal));
              } finally { proposingPayment = false; }
              return json({ ok: true });
            }
            case "/api/sign":
              await app.requestSignatures();
              return json({ ok: true });
            case "/api/cancel":
              await app.cancel("cancelled from dashboard");
              return json({ ok: true });
            case "/api/broadcast": {
              const tx = app.snapshot().session?.complete?.txHex;
              if (!tx) throw new Error("no signed transaction yet");
              if (!opts.actions?.broadcast) throw new Error("broadcast not available");
              const txid = await opts.actions.broadcast(tx);
              app.log(`✓ broadcast to Signet: ${txid}`);
              return json({ ok: true, txid });
            }
          }
          return json({ error: "unknown action" }, 404);
        } catch (e: any) {
          app.log(`✗ ${e?.message ?? e}`);
          return json({ error: e?.message ?? String(e) }, 400);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  // keep proxies/browsers from closing idle SSE connections
  const heartbeat = setInterval(() => { for (const c of clients) try { c.enqueue(enc.encode(": ping\n\n")); } catch { clients.delete(c); } }, 15000);
  return { url: `http://127.0.0.1:${server.port}`, launchUrl: `http://127.0.0.1:${server.port}/#token=${token}`, token, onWire, server, close() { clearInterval(heartbeat); server.stop(true); } };
}
