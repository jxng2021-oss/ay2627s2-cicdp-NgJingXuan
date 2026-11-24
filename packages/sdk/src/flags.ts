import { SecureCloudError } from "./errors.js";
import { Http } from "./http.js";

export type FlagEnvironment = "development" | "staging" | "production";
export type FlagValue = boolean | string;

export interface FlagUser {
  id: string;
  email?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface FlagResult {
  value: FlagValue;
  reason: "off" | "rule" | "rollout" | "default";
  ruleIndex?: number;
}

const ENVIRONMENTS: readonly FlagEnvironment[] = [
  "development",
  "staging",
  "production",
];

export function flagEnvironment(name: string | undefined): FlagEnvironment {
  const environment =
    name ?? process.env.SECURE_CLOUD_ENVIRONMENT ?? "production";
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new SecureCloudError(
      0,
      "INVALID_ENVIRONMENT",
      `"${environment}" isn't an environment. Use development, staging or production.`,
    );
  }
  return environment as FlagEnvironment;
}

export class Flags {
  constructor(
    private readonly http: Http,
    readonly environment: FlagEnvironment,
  ) {}

  async evaluate(
    user: FlagUser,
    keys?: string[],
  ): Promise<Record<string, FlagResult>> {
    if (!user.id) {
      throw new SecureCloudError(
        0,
        "MISSING_USER_ID",
        'Pass the user\'s ID, like flags.isOn("new-checkout", { id: user.id }).',
      );
    }
    const attributes = {
      ...user.attributes,
      ...(user.email ? { email: user.email } : {}),
    };
    const answer = await this.http.json<{
      flags: Record<string, FlagResult>;
    }>(
      "/v1/flags/evaluate",
      Http.body({
        environment: this.environment,
        context: { key: user.id, attributes },
        ...(keys ? { keys } : {}),
      }),
    );
    return answer.flags;
  }

  async isOn(key: string, user: FlagUser): Promise<boolean> {
    return (await this.evaluate(user, [key]))[key]?.value === true;
  }

  async value(
    key: string,
    user: FlagUser,
    fallback: FlagValue,
  ): Promise<FlagValue> {
    return (await this.evaluate(user, [key]))[key]?.value ?? fallback;
  }
}
