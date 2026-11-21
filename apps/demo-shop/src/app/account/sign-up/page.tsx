import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { currentShopper } from "@/lib/shoppers";
import { AccountForm } from "../account-form";

export default async function SignUpPage({
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
        title="Create Account"
        description="Your account is kept by secure-cloud's user pools: this shop never sees a stored password."
      />
      <AccountForm
        mode="sign-up"
        next={typeof next === "string" ? next : undefined}
      />
    </div>
  );
}
