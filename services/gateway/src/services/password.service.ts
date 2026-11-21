import { hash, verify } from "@node-rs/argon2";

const ARGON2ID = 2;
const SETTINGS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "12345678901234",
  "password1234",
  "password12345",
  "password123456",
  "passwordpassword",
  "qwertyuiopas",
  "qwerty123456",
  "qwertyuiop123",
  "111111111111",
  "000000000000",
  "aaaaaaaaaaaa",
  "abcdefghijkl",
  "abc123456789",
  "iloveyou1234",
  "letmein12345",
  "welcome12345",
  "admin1234567",
  "administrator",
  "changeme1234",
  "trustno11234",
  "football1234",
  "baseball1234",
  "superman1234",
  "princess1234",
  "sunshine1234",
  "1q2w3e4r5t6y",
  "zaq12wsxcde3",
  "correcthorsebatterystaple",
]);

export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `The password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "This password is too common; choose another";
  }
  return undefined;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, SETTINGS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(crypto.randomUUID() + crypto.randomUUID());
  await verifyPassword(await dummyHash, password);
  return false;
}
