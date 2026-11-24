"use server";

import { redirect } from "next/navigation";
import { describeError, type ErrorView } from "@/lib/messages";
import {
  changeShopperPassword,
  PlatformError,
  signInShopper,
  signOutShopper,
  signUpShopper,
} from "@/lib/platform/client";
import { clearTokens, currentShopper, saveTokens } from "@/lib/shoppers";

export interface AccountState {
  error?: ErrorView;
  email?: string;
}

function safeNext(value: FormDataEntryValue | null): string {
  return typeof value === "string" &&
    /^\/(products\/[a-z0-9-]{1,64}|account\/orders)$/.test(value)
    ? value
    : "/account/orders";
}

function fields(form: FormData) {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  return { email: text("email").trim(), password: text("password") };
}

export async function signIn(
  _previous: AccountState,
  form: FormData,
): Promise<AccountState> {
  const { email, password } = fields(form);
  let resetRequired: boolean;
  try {
    const tokens = await signInShopper(email, password);
    await saveTokens(tokens);
    resetRequired = tokens.passwordResetRequired;
  } catch (error) {
    if (error instanceof PlatformError && error.code === "UNAUTHORIZED") {
      return {
        email,
        error: {
          title: "Wrong email or password",
          message: "Check both and try again.",
        },
      };
    }
    if (error instanceof PlatformError && error.status === 400) {
      return {
        email,
        error: {
          title: "Check your details",
          message: "Enter your email address and your password.",
        },
      };
    }
    return { email, error: describeError(error) };
  }
  if (resetRequired) redirect("/account/new-password");
  redirect(safeNext(form.get("next")));
}

export async function choosePassword(
  _previous: AccountState,
  form: FormData,
): Promise<AccountState> {
  const shopper = await currentShopper();
  if (!shopper) redirect("/account/sign-in");
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const current = text("currentPassword");
  const next = text("newPassword");
  if (next !== text("confirmPassword")) {
    return {
      error: {
        title: "Passwords don't match",
        message: "Type the same new password twice.",
      },
    };
  }
  try {
    await changeShopperPassword(shopper.id, current, next);
    await saveTokens(await signInShopper(shopper.email, next));
  } catch (error) {
    if (error instanceof PlatformError && error.code === "UNAUTHORIZED") {
      return {
        error: {
          title: "Wrong current password",
          message: "Enter the password you just signed in with.",
        },
      };
    }
    if (error instanceof PlatformError && error.status === 400) {
      return {
        error: {
          title: "Choose another password",
          message: error.message.startsWith("body/")
            ? "Use at least 12 characters."
            : error.message,
        },
      };
    }
    return { error: describeError(error) };
  }
  redirect("/account/orders");
}

export async function signUp(
  _previous: AccountState,
  form: FormData,
): Promise<AccountState> {
  const { email, password } = fields(form);
  try {
    await signUpShopper(email, password);
    await saveTokens(await signInShopper(email, password));
  } catch (error) {
    if (error instanceof PlatformError && error.status === 409) {
      return {
        email,
        error: {
          title: "Account exists",
          message: "That email already has an account. Sign in instead.",
        },
      };
    }
    if (error instanceof PlatformError && error.status === 400) {
      return {
        email,
        error: {
          title: "Check your details",
          message: error.message.startsWith("body/")
            ? "Enter a valid email address and a password."
            : error.message,
        },
      };
    }
    return { email, error: describeError(error) };
  }
  redirect(safeNext(form.get("next")));
}

export async function signOut(): Promise<void> {
  const refresh = await clearTokens();
  if (refresh) await signOutShopper(refresh).catch(() => undefined);
  redirect("/");
}
