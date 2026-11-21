import Link from "next/link";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { formatPrice, PRODUCTS } from "@/lib/catalog";
import { latestImages } from "@/lib/images";
import { describeError } from "@/lib/messages";
import { evaluateFlags, listFiles, type FileInfo } from "@/lib/platform/client";
import { currentShopper } from "@/lib/shoppers";
import { ProductPhoto } from "./product-photo";

export default async function HomePage() {
  let photos = new Map<string, FileInfo>();
  let problem: ReturnType<typeof describeError> | null = null;
  try {
    photos = latestImages(await listFiles());
  } catch (error) {
    problem = describeError(error);
  }
  const shopper = await currentShopper();
  let sale = false;
  try {
    const flags = await evaluateFlags({
      key: shopper?.id ?? "visitor",
      attributes: { signedIn: shopper !== undefined },
    });
    sale = flags["sale-banner"]?.value === true;
  } catch {}

  return (
    <>
      <PageHeader
        label="Demo Shop"
        title="Products"
        description="Everyday goods. Pay through secure-cloud: this shop never holds the payment key."
      />
      {sale && (
        <section className="sale-banner" aria-label="Sale">
          <strong>Holiday sale is on.</strong> Free shipping on every order this
          week.
        </section>
      )}
      {problem && <ErrorBanner error={problem} />}
      <ul className="product-grid">
        {PRODUCTS.map((product) => (
          <li key={product.slug} className="product-card">
            <Link href={`/products/${product.slug}`} className="stack-2">
              <ProductPhoto
                file={photos.get(product.slug)}
                name={product.name}
              />
              <h2 className="product-name">{product.name}</h2>
            </Link>
            <p className="price">{formatPrice(product.priceCents)}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
