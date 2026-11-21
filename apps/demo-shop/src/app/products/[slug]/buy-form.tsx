"use client";

import Link from "next/link";
import { useActionState, useId } from "react";
import { ErrorBanner } from "@/components/ui";
import { MAX_QUANTITY } from "@/lib/catalog";
import { checkout, type CheckoutState } from "./actions";

export function BuyForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(
    checkout,
    {},
  );
  const quantityId = useId();
  return (
    <form action={action} className="form">
      <input type="hidden" name="slug" value={slug} />
      <div className="field">
        <label htmlFor={quantityId}>Quantity</label>
        <select
          id={quantityId}
          name="quantity"
          className="select"
          defaultValue="1"
        >
          {Array.from({ length: MAX_QUANTITY }, (_, i) => String(i + 1)).map(
            (value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ),
          )}
        </select>
      </div>
      {state.error && <ErrorBanner error={state.error} />}
      {state.signIn && (
        <p>
          <Link href={`/account/sign-in?next=/products/${slug}`}>
            Sign in to buy
          </Link>{" "}
          or{" "}
          <Link href={`/account/sign-up?next=/products/${slug}`}>
            create an account
          </Link>
          .
        </p>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={pending}
        >
          {pending ? "Paying..." : "Buy Now"}
        </button>
      </div>
    </form>
  );
}
