import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPaymentEvent,
  attachCheckoutSession,
  createOrder,
  dropUnstartedOrder,
  findShopperOrder,
  listOrders,
  listShopperOrders,
  markPaid,
  ORDERS_SCHEMA,
  saveWebhookPosition,
  webhookPosition,
  type Db,
  type PaymentEvent,
} from "@/lib/orders";

let client: PGlite;
let db: Db;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(ORDERS_SCHEMA);
  db = { query: (text, params) => client.query(text, params) };
});

afterEach(async () => {
  await client.close();
});

const ADA = { id: "shopper-ada", email: "ada@example.com" };
const BOB = { id: "shopper-bob", email: "bob@example.com" };
const ORDER = "6f1c2a3b-0000-4000-8000-000000000001";
const SESSION = "cs_test_a1B2c3D4e5F6g7H8";

async function pendingOrder(id = ORDER, shopper = ADA) {
  const order = await createOrder(db, {
    id,
    shopper,
    slug: "field-notebook",
    productName: "Field Notebook",
    quantity: 2,
    unitCents: 1800,
  });
  await attachCheckoutSession(db, id, `${SESSION}${id.slice(-1)}`);
  return order;
}

const paid = (orderId = ORDER) => ({
  orderId,
  shopperId: ADA.id,
  sessionId: `${SESSION}${orderId.slice(-1)}`,
  paymentId: "pi_123",
  totalCents: 3600,
});

describe("the demo shop's own orders", () => {
  it("a new order is pending, with its total worked out from the catalog price", async () => {
    const order = await pendingOrder();
    expect(order).toMatchObject({
      id: ORDER,
      shopperEmail: "ada@example.com",
      quantity: 2,
      unitCents: 1800,
      totalCents: 3600,
      status: "pending",
      stripePaymentId: null,
    });
    expect(await listShopperOrders(db, ADA.id)).toEqual([]);
    expect((await listOrders(db)).map((o) => o.status)).toEqual(["pending"]);
  });

  it("becomes paid once, with Stripe's payment ID; asking again returns the same order", async () => {
    await pendingOrder();
    const first = await markPaid(db, paid());
    expect(first).toMatchObject({ status: "paid", stripePaymentId: "pi_123" });
    expect(first?.paidAt).not.toBeNull();

    const again = await markPaid(db, paid());
    expect(again?.paidAt).toBe(first?.paidAt);
    expect(await listShopperOrders(db, ADA.id)).toHaveLength(1);
  });

  it("refuses a payment for another shopper, another session or another amount", async () => {
    await pendingOrder();
    expect(
      await markPaid(db, { ...paid(), shopperId: BOB.id }),
    ).toBeUndefined();
    expect(
      await markPaid(db, { ...paid(), sessionId: "cs_test_someoneElse1" }),
    ).toBeUndefined();
    expect(await markPaid(db, { ...paid(), totalCents: 1 })).toBeUndefined();
    expect((await findShopperOrder(db, ORDER, ADA.id))?.status).toBe("pending");
  });

  it("shoppers only see their own orders", async () => {
    await pendingOrder();
    await markPaid(db, paid());
    expect(await findShopperOrder(db, ORDER, BOB.id)).toBeUndefined();
    expect(await listShopperOrders(db, BOB.id)).toEqual([]);
    expect((await findShopperOrder(db, ORDER, ADA.id))?.shopperId).toBe(ADA.id);
  });

  it("the database refuses impossible orders", async () => {
    await expect(
      createOrder(db, {
        id: "6f1c2a3b-0000-4000-8000-000000000009",
        shopper: ADA,
        slug: "field-notebook",
        productName: "Field Notebook",
        quantity: 9,
        unitCents: 1800,
      }),
    ).rejects.toThrow();
  });
});

describe("orders whose payment never started", () => {
  it("are dropped, but never one that reached Stripe or was paid", async () => {
    const lost = "6f1c2a3b-0000-4000-8000-000000000003";
    await createOrder(db, {
      id: lost,
      shopper: ADA,
      slug: "studio-headphones",
      productName: "Studio Headphones",
      quantity: 1,
      unitCents: 129_900,
    });
    await dropUnstartedOrder(db, lost);
    expect(await findShopperOrder(db, lost, ADA.id)).toBeUndefined();

    await pendingOrder();
    await dropUnstartedOrder(db, ORDER);
    expect((await findShopperOrder(db, ORDER, ADA.id))?.status).toBe("pending");
  });
});

describe("payment events from secure-cloud", () => {
  let n = 0;
  const event = (fields: Partial<PaymentEvent>): PaymentEvent => ({
    id: `0f1e2d3c-4b5a-4968-8776-6554433221${String(++n).padStart(2, "0")}`,
    event: "payment.succeeded",
    orderId: ORDER,
    amount: 3600,
    paymentId: "pi_123",
    reason: null,
    ...fields,
  });
  const status = async () =>
    (await findShopperOrder(db, ORDER, ADA.id))!.status;

  it("the schema can run again on an existing database", async () => {
    await client.exec(ORDERS_SCHEMA);
    await pendingOrder();
    expect(await status()).toBe("pending");
  });

  it("a payment marks the order paid once, and only for the right amount", async () => {
    await pendingOrder();
    expect(await applyPaymentEvent(db, event({ amount: 1 }))).toBe("applied");
    expect(await status()).toBe("pending");

    const succeeded = event({});
    expect(await applyPaymentEvent(db, succeeded)).toBe("applied");
    expect(await applyPaymentEvent(db, succeeded)).toBe("repeated");
    expect(await findShopperOrder(db, ORDER, ADA.id)).toMatchObject({
      status: "paid",
      stripePaymentId: "pi_123",
    });
  });

  it("a failed or expired payment marks a pending order failed, never a paid one", async () => {
    await pendingOrder();
    await applyPaymentEvent(
      db,
      event({ event: "payment.failed", reason: "expired" }),
    );
    expect(await status()).toBe("failed");
    await applyPaymentEvent(db, event({}));
    expect(await status()).toBe("paid");
    await applyPaymentEvent(db, event({ event: "payment.failed" }));
    expect(await status()).toBe("paid");
  });

  it("refunds are matched by the payment; a full refund marks it refunded", async () => {
    await pendingOrder();
    await applyPaymentEvent(db, event({}));
    await applyPaymentEvent(
      db,
      event({
        event: "refund.succeeded",
        orderId: null,
        amount: 1000,
        reason: "partial",
      }),
    );
    expect(await findShopperOrder(db, ORDER, ADA.id)).toMatchObject({
      status: "paid",
      refundedCents: 1000,
    });
    await applyPaymentEvent(
      db,
      event({
        event: "refund.succeeded",
        orderId: null,
        amount: 3600,
        reason: "full",
      }),
    );
    expect(await status()).toBe("refunded");
    expect(await listShopperOrders(db, ADA.id)).toHaveLength(1);
  });

  it("events for orders it doesn't know change nothing", async () => {
    await pendingOrder();
    expect(
      await applyPaymentEvent(db, event({ orderId: "not-an-order" })),
    ).toBe("not_ours");
    expect(await status()).toBe("pending");
  });

  it("remembers where pulling stopped", async () => {
    expect(await webhookPosition(db)).toBeUndefined();
    await saveWebhookPosition(db, "4");
    await saveWebhookPosition(db, "9");
    expect(await webhookPosition(db)).toBe("9");
  });
});
