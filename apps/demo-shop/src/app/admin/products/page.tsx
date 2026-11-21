import { ErrorBanner, formatDate, PageHeader, Status } from "@/components/ui";
import { PRODUCTS } from "@/lib/catalog";
import { latestImages } from "@/lib/images";
import { describeError } from "@/lib/messages";
import { listFiles, type FileInfo } from "@/lib/platform/client";
import { PhotoUpload } from "./photo-upload";

export default async function AdminProductsPage() {
  let photos = new Map<string, FileInfo>();
  let problem: ReturnType<typeof describeError> | null = null;
  try {
    photos = latestImages(await listFiles());
  } catch (error) {
    problem = describeError(error);
  }

  return (
    <>
      <PageHeader
        label="Admin"
        title="Product Photos"
        description="PNG, JPEG or WebP, up to 5 MB. Stored encrypted on secure-cloud."
      />
      {problem && <ErrorBanner error={problem} />}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Photo</th>
              <th scope="col">
                <span className="sr-only">Upload</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {PRODUCTS.map((product) => {
              const photo = photos.get(product.slug);
              return (
                <tr key={product.slug}>
                  <td data-label="Product">{product.name}</td>
                  <td data-label="Photo">
                    {photo ? (
                      <Status ok>Uploaded {formatDate(photo.createdAt)}</Status>
                    ) : (
                      <span className="muted">None yet</span>
                    )}
                  </td>
                  <td className="actions">
                    <PhotoUpload slug={product.slug} name={product.name} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
