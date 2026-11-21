import { describe, expect, it } from "vitest";
import { parseProxyPolicy } from "../../services/gateway/src/config.js";
import {
  BlockedTargetError,
  blockedReason,
  checkBaseUrl,
  resolveAndCheck,
  targetUrl,
  type ProxyPolicy,
  type Resolver,
} from "../../services/gateway/src/services/ssrf.service.js";

const STRICT: ProxyPolicy = {
  allowedHosts: ["api.example.com"],
  allowPrivateTargets: false,
};
const LOCAL: ProxyPolicy = { ...STRICT, allowPrivateTargets: true };

describe("addresses", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "198.18.0.1",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
  ])("blocks the private or loopback address %s", (address) => {
    expect(blockedReason(address, STRICT)).toBe("private or loopback address");
  });

  it.each([
    "169.254.169.254",
    "169.254.0.1",
    "100.100.100.200",
    "fd00:ec2::254",
    "fe80::1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "ff02::1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
  ])(
    "always blocks the link-local, metadata or reserved address %s, even locally",
    (address) => {
      expect(blockedReason(address, STRICT)).toBe(
        "link-local, metadata or reserved address",
      );
      expect(blockedReason(address, LOCAL)).toBe(
        "link-local, metadata or reserved address",
      );
    },
  );

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows the public address %s", (address) => {
    expect(blockedReason(address, STRICT)).toBeUndefined();
  });

  it("allows private and loopback addresses only with PROXY_ALLOW_PRIVATE_TARGETS", () => {
    expect(blockedReason("127.0.0.1", LOCAL)).toBeUndefined();
    expect(blockedReason("10.0.0.5", LOCAL)).toBeUndefined();
  });
});

describe("base URLs", () => {
  it("accepts an allowlisted https:// URL", () => {
    expect(checkBaseUrl("https://API.example.com/v1/", STRICT).href).toBe(
      "https://api.example.com/v1/",
    );
  });

  it.each([
    ["http://api.example.com", "must start with https://"],
    ["ftp://api.example.com", "must start with https://"],
    ["file:///etc/passwd", "must start with https://"],
    ["https://user:pass@api.example.com", "username or password"],
    ["https://user@api.example.com", "username or password"],
    ["https://api.example.com/v1?key=1", "query"],
    ["https://api.example.com/v1#x", "fragment"],
    ["https://evil.example", "isn't on the proxy allowlist"],
    ["https://api.example.com.evil.example", "isn't on the proxy allowlist"],
    ["not a url", "isn't a valid absolute URL"],
  ])("refuses %s", (url, reason) => {
    expect(() => checkBaseUrl(url, STRICT)).toThrow(reason);
  });

  it.each([
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://0x7f.0.0.1",
    "https://127.1",
    "https://0177.0.0.1",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:7f00:1]",
    "https://169.254.169.254",
    "https://[fd00:ec2::254]",
    "https://%31%32%37.0.0.1",
  ])("refuses the address %s, written any way, even if allowlisted", (url) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const policy = { allowedHosts: [host], allowPrivateTargets: false };

    expect(() => checkBaseUrl(url, policy)).toThrow(BlockedTargetError);
  });

  it("allows http:// and private addresses only for the local mock (PROXY_ALLOW_PRIVATE_TARGETS)", () => {
    const local = {
      allowedHosts: ["mock-upstream", "10.0.0.5"],
      allowPrivateTargets: true,
    };

    expect(checkBaseUrl("http://mock-upstream:4000/api", local).host).toBe(
      "mock-upstream:4000",
    );
    expect(checkBaseUrl("http://10.0.0.5", local).hostname).toBe("10.0.0.5");
    expect(() =>
      checkBaseUrl("http://169.254.169.254", {
        ...local,
        allowedHosts: ["169.254.169.254"],
      }),
    ).toThrow(BlockedTargetError);
  });
});

describe("resolving the host", () => {
  const resolver =
    (addresses: string[]): Resolver =>
    () =>
      Promise.resolve(
        addresses.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      );

  it("returns the checked address to connect to", async () => {
    await expect(
      resolveAndCheck("api.example.com", STRICT, resolver(["93.184.216.34"])),
    ).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });

  it("refuses if ANY returned address is blocked", async () => {
    await expect(
      resolveAndCheck(
        "api.example.com",
        STRICT,
        resolver(["93.184.216.34", "10.0.0.1"]),
      ),
    ).rejects.toThrow("resolves to a private or loopback address");
    await expect(
      resolveAndCheck(
        "api.example.com",
        STRICT,
        resolver(["2606:4700::1", "::ffff:169.254.169.254"]),
      ),
    ).rejects.toThrow("metadata");
  });

  it("catches a DNS answer that switches to a private address on the next request", async () => {
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    let call = 0;
    const switching: Resolver = (host) => resolver(answers[call++] ?? [])(host);

    await expect(
      resolveAndCheck("api.example.com", STRICT, switching),
    ).resolves.toMatchObject({
      address: "93.184.216.34",
    });
    await expect(
      resolveAndCheck("api.example.com", STRICT, switching),
    ).rejects.toThrow(BlockedTargetError);
  });

  it("refuses a host that doesn't resolve", async () => {
    const failing: Resolver = () => Promise.reject(new Error("ENOTFOUND"));

    await expect(
      resolveAndCheck("api.example.com", STRICT, failing),
    ).rejects.toThrow("could not be resolved");
    await expect(
      resolveAndCheck("api.example.com", STRICT, resolver([])),
    ).rejects.toThrow("could not be resolved");
  });
});

describe("joining the client's path", () => {
  const base = new URL("https://api.example.com/v1");

  it.each([
    ["/charges", "https://api.example.com/v1/charges"],
    [
      "/charges/ch_1?expand=x&limit=2",
      "https://api.example.com/v1/charges/ch_1?expand=x&limit=2",
    ],
    ["", "https://api.example.com/v1"],
    ["/", "https://api.example.com/v1"],
    ["//charges", "https://api.example.com/v1/charges"],
    ["/@evil.example/x", "https://api.example.com/v1/@evil.example/x"],
    [
      "/a?next=https://evil.example",
      "https://api.example.com/v1/a?next=https://evil.example",
    ],
  ])("%s -> %s", (path, expected) => {
    expect(targetUrl(base, path).href).toBe(expected);
  });

  it.each([
    "/../admin",
    "/charges/../../admin",
    "/./x",
    "/%2e%2e/admin",
    "/%2E%2E/admin",
    "/..%2fadmin",
    "/x%2F..%2F..%2Fadmin",
    "/%5c..%5cadmin",
    "/\\evil.example",
    "/x\\..\\admin",
    "/x%00",
    "/x\r\nHost: evil.example",
  ])("refuses %j: it can't change the host or leave the base path", (path) => {
    expect(() => targetUrl(base, path)).toThrow("the path isn't allowed");
  });

  it("keeps the host even for paths that look like URLs", () => {
    for (const path of [
      "/http://evil.example/",
      "//evil.example/x",
      "/https:evil.example",
    ]) {
      expect(targetUrl(base, path).host).toBe("api.example.com");
      expect(targetUrl(base, path).pathname.startsWith("/v1/")).toBe(true);
    }
  });
});

describe("settings", () => {
  it("reads PROXY_ALLOWED_HOSTS", () => {
    expect(
      parseProxyPolicy({
        PROXY_ALLOWED_HOSTS: " API.example.com , mock-upstream",
      }),
    ).toEqual({
      allowedHosts: ["api.example.com", "mock-upstream"],
      allowPrivateTargets: false,
    });
    expect(parseProxyPolicy({}).allowedHosts).toEqual([]);
    expect(() =>
      parseProxyPolicy({ PROXY_ALLOWED_HOSTS: "https://api.example.com" }),
    ).toThrow("plain host names");
  });

  it("refuses to start with PROXY_ALLOW_PRIVATE_TARGETS=true when NODE_ENV=production", () => {
    expect(() =>
      parseProxyPolicy({
        PROXY_ALLOW_PRIVATE_TARGETS: "true",
        NODE_ENV: "production",
      }),
    ).toThrow("refused when NODE_ENV=production");
    expect(
      parseProxyPolicy({
        PROXY_ALLOW_PRIVATE_TARGETS: "true",
        NODE_ENV: "development",
      }).allowPrivateTargets,
    ).toBe(true);
  });
});
