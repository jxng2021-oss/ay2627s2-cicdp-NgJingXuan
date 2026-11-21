import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { currentShopper } from "@/lib/shoppers";
import { AccountForm } from "../account-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await currentShopper()) redirect("/account/orders");
  const { next } = await searchParams;
  return (
    <div className="account">
      <PageHeader
        label="Your Account"
        title="Sign In"
        description="Sign in to buy, and to see your orders."
      />
      <AccountForm
        mode="sign-in"
        next={typeof next === "string" ? next : undefined}
      />
    </div>
  );
}
