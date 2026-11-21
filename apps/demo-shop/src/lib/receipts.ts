export const MAX_RECEIPT_BYTES = 64 * 1024;

export interface Receipt {
  version: 1;
  orderId: string;
  createdAt: string;
  items: { slug: string; name: string; quantity: number; unitCents: number }[];
  totalCents: number;
  currency: "sgd";
  chargeId: string;
  shopper?: { id: string; email: string };
}

export function shopperReceiptPrefix(shopperId: string): string {
  return `receipt-${shopperId}-`;
}

export function receiptFileName(orderId: string, shopperId: string): string {
  return `${shopperReceiptPrefix(shopperId)}${orderId}.json`;
}

export function isReceiptFile(name: string | null): boolean {
  return (
    name !== null && /^receipt-([0-9a-f-]{36}-)?[0-9a-f-]{36}\.json$/.test(name)
  );
}

export function parseReceipt(text: string): Receipt | null {
  try {
    const receipt = JSON.parse(text) as Partial<Receipt>;
    if (
      receipt.version !== 1 ||
      typeof receipt.orderId !== "string" ||
      typeof receipt.totalCents !== "number" ||
      !Array.isArray(receipt.items)
    ) {
      return null;
    }
    return receipt as Receipt;
  } catch {
    return null;
  }
}
