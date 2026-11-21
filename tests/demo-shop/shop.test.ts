import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_MS,
  isAdminPassword,
  isAdminSession,
  newAdminSession,
} from "@/lib/admin-auth";
import { findProduct, formatPrice, parseQuantity } from "@/lib/catalog";
import {
  imageFileName,
  imageSlug,
  isImageType,
  latestImages,
} from "@/lib/images";
import type { FileInfo } from "@/lib/platform/client";
import { isReceiptFile, parseReceipt, type Receipt } from "@/lib/receipts";

const receipt: Receipt = {
  version: 1,
  orderId: "0b9c1f9e-6f5e-4a8a-9e57-2b1f3f2f8d11",
  createdAt: "2026-11-12T10:00:00.000Z",
  items: [
    { slug: "enamel-mug", name: "Enamel Mug", quantity: 2, unitCents: 2400 },
  ],
  totalCents: 4800,
  currency: "sgd",
  chargeId: "ch_test",
};

describe("receipts", () => {
  it("parses only receipt files", () => {
    expect(parseReceipt(JSON.stringify(receipt))?.totalCents).toBe(4800);
    expect(parseReceipt("not json")).toBeNull();
    expect(parseReceipt(JSON.stringify({ version: 2 }))).toBeNull();
    expect(isReceiptFile(`receipt-${receipt.orderId}.json`)).toBe(true);
    expect(isReceiptFile("receipt-../../x.json")).toBe(false);
    expect(isReceiptFile(null)).toBe(false);
  });
});

describe("catalog", () => {
  it("prices come from the catalog, and quantities are 1 to 5", () => {
    expect(findProduct("enamel-mug")?.priceCents).toBe(2400);
    expect(findProduct("nope")).toBeUndefined();
    expect(parseQuantity("3")).toBe(3);
    for (const bad of ["0", "6", "-1", "1.5", "", "two", null]) {
      expect(parseQuantity(bad)).toBeNull();
    }
    expect(formatPrice(129_900)).toBe("S$1,299.00");
    expect(formatPrice(1800)).toBe("S$18.00");
  });
});

describe("product photos", () => {
  const file = (
    name: string,
    contentType: string,
    createdAt: string,
  ): FileInfo => ({
    id: `id-${name}-${createdAt}`,
    name,
    contentType,
    size: 10,
    createdAt,
  });

  it("only images, named product-<slug>, newest first", () => {
    const files = [
      file("product-enamel-mug.png", "image/png", "2026-11-12T10:00:00Z"),
      file("product-enamel-mug.jpg", "image/jpeg", "2026-11-12T11:00:00Z"),
      file("product-canvas-tote.png", "text/html", "2026-11-12T12:00:00Z"),
      file("receipt-x.json", "application/json", "2026-11-12T12:00:00Z"),
    ];
    const latest = latestImages(files);
    expect(latest.get("enamel-mug")?.name).toBe("product-enamel-mug.jpg");
    expect(latest.has("canvas-tote")).toBe(false);
    expect(imageSlug(files[3]!)).toBeNull();
  });

  it("accepts PNG, JPEG and WebP only", () => {
    expect(isImageType("image/png")).toBe(true);
    for (const type of ["image/svg+xml", "text/html", "image/png; x", null]) {
      expect(isImageType(type)).toBe(false);
    }
    expect(imageFileName("enamel-mug", "image/webp")).toBe(
      "product-enamel-mug.webp",
    );
  });
});

describe("admin login", () => {
  it("accepts only the right password", () => {
    expect(isAdminPassword("s3cret", "s3cret")).toBe(true);
    expect(isAdminPassword("wrong", "s3cret")).toBe(false);
    expect(isAdminPassword("", "s3cret")).toBe(false);
  });

  it("is off when no password is set", () => {
    expect(isAdminPassword("", "")).toBe(false);
    expect(isAdminPassword("undefined", undefined)).toBe(false);
    expect(isAdminSession("1.x", Date.now(), undefined)).toBe(false);
  });

  it("a session works until it expires, and only with its own password", () => {
    const now = 1_800_000_000_000;
    const session = newAdminSession(now, "s3cret");
    expect(isAdminSession(session, now + 1000, "s3cret")).toBe(true);
    expect(isAdminSession(session, now + ADMIN_SESSION_MS, "s3cret")).toBe(
      false,
    );
    expect(isAdminSession(session, now + 1000, "changed")).toBe(false);
  });

  it("refuses forged or edited sessions", () => {
    const now = 1_800_000_000_000;
    const [expires, signature] = newAdminSession(now, "s3cret").split(".");
    const later = String(Number(expires) + 86_400_000);
    for (const forged of [
      `${later}.${signature}`,
      `${expires}.${"A".repeat(43)}`,
      "garbage",
      undefined,
    ]) {
      expect(isAdminSession(forged, now, "s3cret")).toBe(false);
    }
  });
});
