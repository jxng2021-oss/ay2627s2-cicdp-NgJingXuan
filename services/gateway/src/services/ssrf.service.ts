import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ProxyPolicy {
  allowedHosts: string[];
  allowPrivateTargets: boolean;
}

export type Resolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export class BlockedTargetError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BlockedTargetError";
  }
}

const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4");
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addSubnet("240.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addAddress("100.100.100.200", "ipv4");
ALWAYS_BLOCKED.addAddress("::", "ipv6");
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6");
ALWAYS_BLOCKED.addSubnet("ff00::", 8, "ipv6");
ALWAYS_BLOCKED.addAddress("fd00:ec2::254", "ipv6");

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.0.0.0", 24, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");

function embeddedIPv4(address: string): string | undefined {
  const groups = expandIPv6(address);
  if (!groups) return undefined;
  const v4 = (high: number, low: number) =>
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  const zeros = (from: number, to: number) =>
    groups.slice(from, to).every((g) => g === 0);
  if (zeros(0, 5) && groups[5] === 0xffff) {
    return v4(groups[6]!, groups[7]!);
  }
  if (zeros(0, 6) && groups[6] !== 0) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) {
    return v4(groups[6]!, groups[7]!);
  }
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  return undefined;
}

function expandIPv6(address: string): number[] | undefined {
  let text = address.toLowerCase().split("%")[0] ?? "";
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a, b, c, d] = dotted[1].split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text =
      text.slice(0, -dotted[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) =>
    part ? part.split(":").map((g) => parseInt(g, 16)) : [];
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  const missing = 8 - front.length - back.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return undefined;
  const groups = [...front, ...Array<number>(missing).fill(0), ...back];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : undefined;
}

export function blockedReason(
  address: string,
  policy: ProxyPolicy,
): string | undefined {
  const family = isIP(address);
  if (family === 0) return "not an IP address";
  if (family === 6) {
    const v4 = embeddedIPv4(address);
    if (v4) return blockedReason(v4, policy);
  }
  const type = family === 4 ? "ipv4" : "ipv6";
  if (ALWAYS_BLOCKED.check(address, type))
    return "link-local, metadata or reserved address";
  if (!policy.allowPrivateTargets && PRIVATE.check(address, type)) {
    return "private or loopback address";
  }
  return undefined;
}

export function checkBaseUrl(text: string, policy: ProxyPolicy): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BlockedTargetError("baseUrl isn't a valid absolute URL");
  }
  const allowedSchemes = policy.allowPrivateTargets
    ? ["https:", "http:"]
    : ["https:"];
  if (!allowedSchemes.includes(url.protocol)) {
    throw new BlockedTargetError("baseUrl must start with https://");
  }
  if (url.username || url.password) {
    throw new BlockedTargetError(
      "baseUrl can't contain a username or password",
    );
  }
  if (url.search || url.hash) {
    throw new BlockedTargetError(
      "baseUrl can't have a query (?...) or fragment (#...)",
    );
  }
  const host = hostOf(url);
  if (!policy.allowedHosts.includes(host)) {
    throw new BlockedTargetError(
      `the host ${host} isn't on the proxy allowlist (PROXY_ALLOWED_HOSTS)`,
    );
  }
  if (isIP(host)) {
    const reason = blockedReason(host, policy);
    if (reason) throw new BlockedTargetError(`baseUrl points at a ${reason}`);
  }
  return url;
}

export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export async function resolveAndCheck(
  host: string,
  policy: ProxyPolicy,
  resolver: Resolver,
): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolver(host).catch(() => {
        throw new BlockedTargetError(`the host ${host} could not be resolved`);
      });
  if (addresses.length === 0)
    throw new BlockedTargetError(`the host ${host} could not be resolved`);
  for (const { address } of addresses) {
    const reason = blockedReason(address, policy);
    if (reason)
      throw new BlockedTargetError(`the host ${host} resolves to a ${reason}`);
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

const DANGEROUS_ENCODINGS = /%(2f|5c|2e|[01][0-9a-f]|7f)/i;

export function targetUrl(base: URL, clientPathAndQuery: string): URL {
  const [rawPath = "", ...queryParts] = clientPathAndQuery.split("?");
  const query = queryParts.length > 0 ? `?${queryParts.join("?")}` : "";
  if (
    rawPath.includes("\\") ||
    DANGEROUS_ENCODINGS.test(rawPath) ||
    // eslint-disable-next-line no-control-regex -- control characters are exactly what's refused
    /[\u0000-\u001f\u007f]/.test(clientPathAndQuery) ||
    rawPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new BlockedTargetError("the path isn't allowed");
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const path = `/${rawPath.replace(/^\/+/, "")}`;
  const target = new URL(
    `${base.origin}${basePath}${path === "/" ? "" : path}${query}`,
  );
  if (
    target.origin !== base.origin ||
    !(
      target.pathname === basePath ||
      target.pathname.startsWith(`${basePath}/`) ||
      basePath === ""
    )
  ) {
    throw new BlockedTargetError("the path isn't allowed");
  }
  return target;
}
