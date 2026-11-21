import { cookies } from "next/headers";
import { shopperPool, shoppers, type ShopperTokens } from "./platform/client";

export const ACCESS_COOKIE = "shop_access";
export const REFRESH_COOKIE = "shop_refresh";
const REFRESH_MAX_AGE = 7 * 86_400;

export interface Shopper {
  id: string;
  email: string;
}

export async function verifyAccessToken(
  token: string,
): Promise<Shopper | undefined> {
  if (!shopperPool()) return undefined;
  try {
    const user = await shoppers().verify(token);
    return { id: user.id, email: user.email };
  } catch {
    return undefined;
  }
}

export async function currentShopper(): Promise<Shopper | undefined> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  return token ? verifyAccessToken(token) : undefined;
}

const secure = () => process.env.SHOP_COOKIES_SECURE === "true";

export function tokenCookies(tokens: ShopperTokens) {
  const common = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: secure(),
  };
  return [
    {
      name: ACCESS_COOKIE,
      value: tokens.accessToken,
      ...common,
      maxAge: tokens.expiresIn,
    },
    {
      name: REFRESH_COOKIE,
      value: tokens.refreshToken,
      ...common,
      maxAge: REFRESH_MAX_AGE,
    },
  ];
}

export async function saveTokens(tokens: ShopperTokens): Promise<void> {
  const store = await cookies();
  for (const cookie of tokenCookies(tokens)) store.set(cookie);
}

export async function clearTokens(): Promise<string | undefined> {
  const store = await cookies();
  const refresh = store.get(REFRESH_COOKIE)?.value;
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  return refresh;
}
