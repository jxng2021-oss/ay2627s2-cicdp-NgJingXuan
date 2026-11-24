import {
  applyPaymentEvent,
  saveWebhookPosition,
  webhookPosition,
  type Db,
} from "./orders";
import { pullWebhookEvents } from "./platform/client";

export function pullsWebhooks(): boolean {
  return process.env.PLATFORM_WEBHOOK_MODE === "pull";
}

export async function syncWebhookEvents(db: Db): Promise<void> {
  if (!pullsWebhooks()) return;
  let after = await webhookPosition(db);
  for (let page = 0; page < 10; page++) {
    const { events, next } = await pullWebhookEvents(after);
    for (const event of events) await applyPaymentEvent(db, event);
    if (next === after || events.length === 0) break;
    await saveWebhookPosition(db, next);
    after = next;
  }
}
