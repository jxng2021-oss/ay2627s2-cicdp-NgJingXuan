import { randomUUID } from "node:crypto";
import Fastify from "fastify";

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  at: string;
}

const recorded: Recorded[] = [];
const app = Fastify({ logger: false });

app.removeAllContentTypeParsers();
app.addContentTypeParser("*", (_request, _payload, done) => {
  done(null);
});

async function bodySize(stream: NodeJS.ReadableStream): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).length;
  return bytes;
}

app.all("/api/error", async (request, reply) => {
  await bodySize(request.raw);
  return reply.code(500).send({ mock: "the outside API failed" });
});

app.all("/api/redirect", async (request, reply) => {
  await bodySize(request.raw);
  return reply
    .code(302)
    .header("location", "http://mock-upstream:4000/api/stolen")
    .send();
});

app.all<{ Querystring: { ms?: string } }>("/api/slow", async (request) => {
  await bodySize(request.raw);
  const ms = Math.min(Number(request.query.ms ?? 5000) || 0, 10_000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { ok: true, waitedMs: ms };
});

app.all("/api/record", async (request) => {
  await bodySize(request.raw);
  recorded.push({
    method: request.method,
    path: request.url,
    headers: request.headers,
    at: new Date().toISOString(),
  });
  if (recorded.length > 50) recorded.shift();
  return { recorded: true };
});

const PAYMENT_KEY =
  process.env.MOCK_PAYMENT_API_KEY ?? "local-demo-payment-key";
const DECLINE_ABOVE = 100_000;

async function smallJson(stream: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += (chunk as Buffer).length;
    if (bytes > 4096) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

app.post("/api/payments/charges", async (request, reply) => {
  const body = await smallJson(request.raw);
  if (request.headers.authorization !== `Bearer ${PAYMENT_KEY}`) {
    return reply.code(401).send({ error: { type: "invalid_api_key" } });
  }
  const charge = body as {
    amount?: unknown;
    currency?: unknown;
    description?: unknown;
  };
  if (
    typeof charge?.amount !== "number" ||
    !Number.isInteger(charge.amount) ||
    charge.amount <= 0 ||
    charge.currency !== "sgd" ||
    typeof charge.description !== "string" ||
    charge.description.length > 200
  ) {
    return reply.code(400).send({ error: { type: "invalid_request" } });
  }
  if (charge.amount > DECLINE_ABOVE) {
    return reply.code(402).send({ error: { type: "card_declined" } });
  }
  return reply.code(201).send({
    id: `ch_${randomUUID().replaceAll("-", "")}`,
    status: "succeeded",
    amount: charge.amount,
    currency: charge.currency,
    description: charge.description,
  });
});

app.all("/api/*", async (request) => ({
  ok: true,
  method: request.method,
  path: request.url.split("?")[0],
  query: request.query,
  bodyBytes: await bodySize(request.raw),
}));

app.get("/__requests", () => ({ requests: recorded }));
app.delete("/__requests", (_request, reply) => {
  recorded.length = 0;
  return reply.code(204).send();
});
app.get("/health", () => ({ status: "ok" }));

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4000) });
