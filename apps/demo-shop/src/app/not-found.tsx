import Link from "next/link";
import { PageHeader } from "@/components/ui";

export default function NotFound() {
  return (
    <>
      <PageHeader
        title="Page Not Found"
        description="That product or order doesn't exist."
      />
      <p>
        <Link href="/">Back to Products</Link>
      </p>
    </>
  );
}
