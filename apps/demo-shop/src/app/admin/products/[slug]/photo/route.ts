import { findProduct } from "@/lib/catalog";
import {
  imageFileName,
  imageSlug,
  isImageType,
  MAX_IMAGE_BYTES,
} from "@/lib/images";
import {
  deleteFile,
  listFiles,
  PlatformError,
  uploadFile,
} from "@/lib/platform/client";

function answer(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

function limited(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_IMAGE_BYTES) {
          controller.error(new Error("too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (
    request.headers.get("x-demo-shop") !== "upload" ||
    !origin ||
    !host ||
    new URL(origin).host !== host
  ) {
    return answer(403, "Uploads must come from the shop's admin page.");
  }

  const product = findProduct((await params).slug);
  if (!product) return answer(404, "That product doesn't exist.");

  const contentType = request.headers.get("content-type");
  if (!isImageType(contentType)) {
    return answer(415, "Choose a PNG, JPEG or WebP photo.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES || !request.body) {
    return answer(413, "Choose a photo up to 5 MB.");
  }

  try {
    const uploaded = await uploadFile(
      imageFileName(product.slug, contentType!),
      contentType!,
      limited(request.body),
    );
    for (const file of await listFiles()) {
      if (imageSlug(file) === product.slug && file.id !== uploaded.id) {
        await deleteFile(file.id);
      }
    }
    return answer(201, "Photo uploaded");
  } catch (error) {
    if (error instanceof PlatformError) {
      return answer(
        error.code === "SECRETS_SEALED" ? 503 : 502,
        error.code === "SECRETS_SEALED"
          ? "The platform is sealed: photos can't be stored. Unseal it, then retry."
          : `The platform refused the upload (${error.code}).`,
      );
    }
    return answer(413, "Choose a photo up to 5 MB.");
  }
}
