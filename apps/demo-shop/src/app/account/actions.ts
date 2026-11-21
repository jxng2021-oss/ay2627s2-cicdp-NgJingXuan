"use server";

import { redirect } from "next/navigation";
import { describeError, type ErrorView } from "@/lib/messages";
import {
  PlatformError,
  signInShopper,
  signOutShopper,
  signUpShopper,
} from "@/lib/platform/client";
import { clearTokens, saveTokens } from "@/lib/shoppers";

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
  try {
    await saveTokens(await signInShopper(email, password));
  } catch (error) {
    if (error instanceof PlatformError && error.status === 401) {
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
  redirect(safeNext(form.get("next")));
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
