import type { FileInfo } from "@/lib/platform/client";

export function ProductPhoto({
  file,
  name,
}: {
  file: FileInfo | undefined;
  name: string;
}) {
  if (!file) {
    return (
      <span
        className="product-photo product-photo-empty"
        role="img"
        aria-label={`No photo of ${name} yet`}
      >
        No photo yet
      </span>
    );
  }
  return (
    <img className="product-photo" src={`/images/${file.id}`} alt={name} />
  );
}
