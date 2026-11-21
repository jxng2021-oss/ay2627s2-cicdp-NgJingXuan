"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_MS,
  isAdminPassword,
  newAdminSession,
} from "@/lib/admin-auth";

export interface AdminLoginState {
  error?: string;
}

function safeNext(value: FormDataEntryValue | null): string {
  return typeof value === "string" &&
    /^\/admin(\/(products|orders|activity))?$/.test(value)
    ? value
    : "/admin";
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
  secure: process.env.SHOP_COOKIES_SECURE === "true",
});

export async function adminSignIn(
  _previous: AdminLoginState,
  form: FormData,
): Promise<AdminLoginState> {
  const password = form.get("password");
  if (typeof password !== "string" || password === "") {
    return { error: "Enter the admin password." };
  }
  if (!process.env.SHOP_ADMIN_PASSWORD) {
    return { error: "Admin is off: run pnpm demo:setup first." };
  }
  if (!isAdminPassword(password)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { error: "That isn't the admin password." };
  }
  (await cookies()).set({
    name: ADMIN_COOKIE,
    value: newAdminSession(),
    maxAge: ADMIN_SESSION_MS / 1000,
    ...cookieOptions(),
  });
  redirect(safeNext(form.get("next")));
}

export async function adminSignOut(): Promise<void> {
  (await cookies()).delete({ name: ADMIN_COOKIE, ...cookieOptions() });
  redirect("/admin-login");
}
