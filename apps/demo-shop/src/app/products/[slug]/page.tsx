import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorBanner } from "@/components/ui";
import { findProduct, formatPrice } from "@/lib/catalog";
import { latestImages } from "@/lib/images";
import { describeError, paymentProblem } from "@/lib/messages";
import { listFiles, type FileInfo } from "@/lib/platform/client";
import { ProductPhoto } from "../../product-photo";
import { BuyForm } from "./buy-form";

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cancelled = paymentProblem((await searchParams).payment);
  const product = findProduct((await params).slug);
  if (!product) notFound();

  let photo: FileInfo | undefined;
  let problem: ReturnType<typeof describeError> | null = null;
  try {
    photo = latestImages(await listFiles()).get(product.slug);
  } catch (error) {
    problem = describeError(error);
  }

  return (
    <>
      <p>
        <Link href="/">← All products</Link>
      </p>
      {problem && <ErrorBanner error={problem} />}
      {cancelled && <ErrorBanner error={cancelled} />}
      <div className="product-detail">
        <ProductPhoto file={photo} name={product.name} />
        <div className="section">
          <div className="stack-2">
            <p className="sec-label">Product</p>
            <h1>{product.name}</h1>
            <p className="price">{formatPrice(product.priceCents)}</p>
            <p className="muted">{product.description}</p>
          </div>
          <BuyForm slug={product.slug} />
          <p className="muted">
            Demo: the platform&apos;s payment policy blocks orders over S$500.00
            (S$2,000.00 a day).
          </p>
        </div>
      </div>
    </>
  );
}
