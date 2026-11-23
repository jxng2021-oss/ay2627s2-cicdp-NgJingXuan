import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { currentShopper } from "@/lib/shoppers";
import { NewPasswordForm } from "./new-password-form";

export default async function NewPasswordPage() {
  const shopper = await currentShopper();
  if (!shopper) redirect("/account/sign-in");
  return (
    <div className="account">
      <PageHeader
        label="Your Account"
        title="Choose a New Password"
        description={`The shop asked ${shopper.email} to choose a new password before carrying on.`}
      />
      <NewPasswordForm />
    </div>
  );
}
