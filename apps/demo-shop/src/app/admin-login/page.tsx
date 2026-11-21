import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { ADMIN_COOKIE, isAdminSession } from "@/lib/admin-auth";
import { AdminLoginForm } from "./login-form";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (isAdminSession((await cookies()).get(ADMIN_COOKIE)?.value)) {
    redirect("/admin");
  }
  const { next } = await searchParams;
  return (
    <div className="account">
      <PageHeader
        label="Shop admin"
        title="Admin sign in"
        description="For whoever runs the shop: product photos, orders and the platform's activity."
      />
      <AdminLoginForm next={typeof next === "string" ? next : undefined} />
    </div>
  );
}
