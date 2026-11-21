import type { FileInfo } from "./platform/client";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function isImageType(contentType: string | null): boolean {
  return contentType !== null && contentType in IMAGE_TYPES;
}

export function imageFileName(slug: string, contentType: string): string {
  return `product-${slug}.${IMAGE_TYPES[contentType] ?? "bin"}`;
}

export function imageSlug(file: FileInfo): string | null {
  if (!isImageType(file.contentType)) return null;
  const match = /^product-([a-z0-9-]+)\.(png|jpg|webp)$/.exec(file.name ?? "");
  return match?.[1] ?? null;
}

export function latestImages(files: FileInfo[]): Map<string, FileInfo> {
  const latest = new Map<string, FileInfo>();
  for (const file of files) {
    const slug = imageSlug(file);
    if (!slug) continue;
    const current = latest.get(slug);
    if (!current || file.createdAt > current.createdAt) latest.set(slug, file);
  }
  return latest;
}
