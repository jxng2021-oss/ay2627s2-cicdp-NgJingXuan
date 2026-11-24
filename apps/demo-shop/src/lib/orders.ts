export interface Db {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export const ORDERS_SCHEMA = `
create table if not exists orders (
  id uuid primary key,
  shopper_id text not null,
  shopper_email text not null,
  product_slug text not null,
  product_name text not null,
  quantity integer not null check (quantity between 1 and 5),
  unit_cents integer not null check (unit_cents > 0),
  total_cents integer not null check (total_cents > 0),
  currency text not null default 'sgd',
  status text not null default 'pending' check (status in ('pending', 'paid')),
  stripe_session_id text unique,
  stripe_payment_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists orders_shopper_idx on orders (shopper_id, created_at desc);
alter table orders add column if not exists refunded_cents integer not null default 0;
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('pending', 'paid', 'failed', 'refunded'));
create index if not exists orders_payment_idx on orders (stripe_payment_id);
create table if not exists webhook_events (
  id uuid primary key,
  received_at timestamptz not null default now()
);
create table if not exists shop_settings (
  name text primary key,
  value text not null
);
`;

export type OrderStatus = "pending" | "paid" | "failed" | "refunded";

export interface Order {
  id: string;
  shopperId: string;
  shopperEmail: string;
  slug: string;
  productName: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
  status: OrderStatus;
  stripeSessionId: string | null;
  stripePaymentId: string | null;
  refundedCents: number;
  createdAt: string;
  paidAt: string | null;
}

interface OrderRow {
  id: string;
  shopper_id: string;
  shopper_email: string;
  product_slug: string;
  product_name: string;
  quantity: number;
  unit_cents: number;
  total_cents: number;
  status: OrderStatus;
  stripe_session_id: string | null;
  stripe_payment_id: string | null;
  refunded_cents: number;
  created_at: Date | string;
  paid_at: Date | string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    shopperId: row.shopper_id,
    shopperEmail: row.shopper_email,
    slug: row.product_slug,
    productName: row.product_name,
    quantity: row.quantity,
    unitCents: row.unit_cents,
    totalCents: row.total_cents,
    status: row.status,
    stripeSessionId: row.stripe_session_id,
    stripePaymentId: row.stripe_payment_id,
    refundedCents: row.refunded_cents,
    createdAt: iso(row.created_at),
    paidAt: row.paid_at === null ? null : iso(row.paid_at),
  };
}

const rows = async (result: Promise<{ rows: unknown[] }>) =>
  ((await result).rows as OrderRow[]).map(toOrder);

export async function createOrder(
  db: Db,
  order: {
    id: string;
    shopper: { id: string; email: string };
    slug: string;
    productName: string;
    quantity: number;
    unitCents: number;
  },
): Promise<Order> {
  const [created] = await rows(
    db.query(
      `insert into orders (id, shopper_id, shopper_email, product_slug, product_name, quantity, unit_cents, total_cents)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        order.id,
        order.shopper.id,
        order.shopper.email,
        order.slug,
        order.productName,
        order.quantity,
        order.unitCents,
        order.unitCents * order.quantity,
      ],
    ),
  );
  return created!;
}

export async function attachCheckoutSession(
  db: Db,
  orderId: string,
  sessionId: string,
): Promise<void> {
  await db.query(
    "update orders set stripe_session_id = $2 where id = $1 and status = 'pending'",
    [orderId, sessionId],
  );
}

export async function dropUnstartedOrder(
  db: Db,
  orderId: string,
): Promise<void> {
  await db.query(
    "delete from orders where id = $1 and status = 'pending' and stripe_session_id is null",
    [orderId],
  );
}

export async function markPaid(
  db: Db,
  paid: {
    orderId: string;
    shopperId: string;
    sessionId: string;
    paymentId: string;
    totalCents: number;
  },
): Promise<Order | undefined> {
  const [updated] = await rows(
    db.query(
      `update orders set status = 'paid', stripe_payment_id = $4, paid_at = now()
       where id = $1 and shopper_id = $2 and stripe_session_id = $3 and total_cents = $5 and status = 'pending'
       returning *`,
      [
        paid.orderId,
        paid.shopperId,
        paid.sessionId,
        paid.paymentId,
        paid.totalCents,
      ],
    ),
  );
  if (updated) return updated;
  const [already] = await rows(
    db.query(
      `select * from orders
       where id = $1 and shopper_id = $2 and stripe_session_id = $3 and status = 'paid'`,
      [paid.orderId, paid.shopperId, paid.sessionId],
    ),
  );
  return already;
}

export async function findShopperOrder(
  db: Db,
  orderId: string,
  shopperId: string,
): Promise<Order | undefined> {
  const [order] = await rows(
    db.query("select * from orders where id = $1 and shopper_id = $2", [
      orderId,
      shopperId,
    ]),
  );
  return order;
}

export function listShopperOrders(db: Db, shopperId: string): Promise<Order[]> {
  return rows(
    db.query(
      "select * from orders where shopper_id = $1 and status in ('paid', 'refunded') order by created_at desc limit 100",
      [shopperId],
    ),
  );
}

export function listOrders(db: Db): Promise<Order[]> {
  return rows(
    db.query("select * from orders order by created_at desc limit 200"),
  );
}

export const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Pending",
  paid: "Paid",
  failed: "Payment failed",
  refunded: "Refunded",
};

export async function readOrders<T>(
  db: Db,
  read: (db: Db) => Promise<T>,
  sync: (db: Db) => Promise<void>,
): Promise<T> {
  try {
    await sync(db);
  } catch {
    console.warn("couldn't pull webhook events; showing orders as stored");
  }
  return read(db);
}

export interface PaymentEvent {
  id: string;
  event: "payment.succeeded" | "payment.failed" | "refund.succeeded";
  orderId: string | null;
  amount: number | null;
  paymentId: string | null;
  reason: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function changeFor(event: PaymentEvent): [string, unknown[]] | undefined {
  const order =
    event.orderId && UUID.test(event.orderId) ? event.orderId : null;
  switch (event.event) {
    case "payment.succeeded":
      if (!order || event.amount === null || !event.paymentId) return undefined;
      return [
        `update orders set status = 'paid', stripe_payment_id = $2, paid_at = now()
         where id = $1 and total_cents = $3 and status in ('pending', 'failed')`,
        [order, event.paymentId, event.amount],
      ];
    case "payment.failed":
      if (!order) return undefined;
      return [
        "update orders set status = 'failed' where id = $1 and status = 'pending'",
        [order],
      ];
    case "refund.succeeded":
      if (!event.paymentId || event.amount === null) return undefined;
      return [
        `update orders set refunded_cents = least($2, total_cents),
           status = case when $2 >= total_cents then 'refunded' else status end
         where stripe_payment_id = $1 and status in ('paid', 'refunded')`,
        [event.paymentId, event.amount],
      ];
  }
}

export async function applyPaymentEvent(
  db: Db,
  event: PaymentEvent,
): Promise<"applied" | "repeated" | "not_ours"> {
  const seen = await db.query("select id from webhook_events where id = $1", [
    event.id,
  ]);
  if (seen.rows.length > 0) return "repeated";
  const change = changeFor(event);
  if (change) await db.query(...change);
  await db.query(
    "insert into webhook_events (id) values ($1) on conflict do nothing",
    [event.id],
  );
  return change ? "applied" : "not_ours";
}

export async function webhookPosition(db: Db): Promise<string | undefined> {
  const { rows: found } = await db.query(
    "select value from shop_settings where name = 'webhook_position'",
  );
  return (found[0] as { value: string } | undefined)?.value;
}

export async function saveWebhookPosition(db: Db, next: string): Promise<void> {
  await db.query(
    `insert into shop_settings (name, value) values ('webhook_position', $1)
     on conflict (name) do update set value = excluded.value`,
    [next],
  );
}
