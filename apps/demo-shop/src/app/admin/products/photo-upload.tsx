"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type ChangeEvent } from "react";

export function PhotoUpload({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const inputId = useId();
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus("Uploading...");
    try {
      const response = await fetch(`/admin/products/${slug}/photo`, {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-demo-shop": "upload",
        },
        body: file,
      });
      const body = (await response.json()) as { message?: string };
      setStatus(
        response.ok ? "Photo uploaded" : (body.message ?? "Upload failed"),
      );
      if (response.ok) router.refresh();
    } catch {
      setStatus("Couldn't reach the shop. Check your connection, then retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row upload-row">
      <label htmlFor={inputId} className="button" data-variant="secondary">
        {busy ? "Uploading..." : "Upload Photo"}
        <span className="sr-only"> for {name}</span>
      </label>
      <input
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        disabled={busy}
        onChange={(event) => void upload(event)}
        data-testid={`photo-${slug}`}
      />
      <span role="status" className="muted">
        {status}
      </span>
    </div>
  );
}
