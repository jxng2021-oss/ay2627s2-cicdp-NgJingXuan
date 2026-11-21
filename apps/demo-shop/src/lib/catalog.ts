export interface Product {
  slug: string;
  name: string;
  description: string;
  priceCents: number;
}

export const PRODUCTS: readonly Product[] = [
  {
    slug: "field-notebook",
    name: "Field Notebook",
    description:
      "A pocket notebook with 96 dot-grid pages and a stitched spine.",
    priceCents: 1800,
  },
  {
    slug: "enamel-mug",
    name: "Enamel Mug",
    description: "A 350 ml steel mug with a white enamel finish.",
    priceCents: 2400,
  },
  {
    slug: "canvas-tote",
    name: "Canvas Tote",
    description: "A heavy cotton tote with an inside pocket.",
    priceCents: 3200,
  },
  {
    slug: "studio-headphones",
    name: "Studio Headphones",
    description: "Closed-back headphones for long listening sessions.",
    priceCents: 129_900,
  },
];

export const MAX_QUANTITY = 5;

export function findProduct(slug: string): Product | undefined {
  return PRODUCTS.find((product) => product.slug === slug);
}

export function parseQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]{1,2}$/.test(value)) return null;
  const quantity = Number(value);
  return quantity >= 1 && quantity <= MAX_QUANTITY ? quantity : null;
}

export function formatPrice(cents: number): string {
  const amount = (cents / 100).toLocaleString("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `S$${amount}`;
}
