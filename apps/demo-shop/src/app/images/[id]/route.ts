import { imageSlug } from "@/lib/images";
import { fileBody, fileMetadata, PlatformError } from "@/lib/platform/client";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  try {
    const file = await fileMetadata(id);
    if (!imageSlug(file)) return notFound();
    const body = await fileBody(id);
    const headers = new Headers({
      "content-type": file.contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
      "content-length": String(file.size),
    });
    return new Response(body, { status: 200, headers });
  } catch (error) {
    if (error instanceof PlatformError && error.status === 404) {
      return notFound();
    }
    const sealed =
      error instanceof PlatformError && error.code === "SECRETS_SEALED";
    return new Response("Photo unavailable", {
      status: sealed ? 503 : 502,
      headers: sealed ? { "retry-after": "30" } : {},
    });
  }
}
