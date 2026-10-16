import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertArrayIncludes } from "https://deno.land/std@0.224.0/assert/assert_array_includes.ts";
import {
  computePlan,
  type GlobalArgs,
  intToIpv4,
  ipv4ToInt,
  nextPow2,
} from "./ipam.ts";

// ---------------------------------------------------------------------------
// Fixture — same v6-complete shape used by ipam_test.ts's minimalArgs(),
// reproduced here so this file has no cross-file coupling. Kept identical
// in content/shape to that fixture.
// ---------------------------------------------------------------------------

function minimalArgs(): GlobalArgs {
  return {
    root: "3fff:0db8",
    rootLength: 36,
    infraRegion: "infra",
    infraSlot: "0e",
    loopbackSuffix: "ffff",
    regions: {
      infra: { nibble: "0", purpose: "Infrastructure", status: "active" },
      na: { nibble: "b", purpose: "North America", status: "active" },
    },
    sites: {
      dc1: {
        region: "na",
        slotNibble: "1",
        offsetNibble: "0",
        name: "DC1",
        location: "Ashburn, VA",
        provider: "Example",
        status: "active",
      },
    },
    subnets: {
      "dc1-mgmt": {
        site: "dc1",
        vlan: 10,
        nibbles: "0010",
        purpose: "Management",
        status: "active",
      },
    },
    tunnels: {
      "tun0": {
        endpointA: "DC1",
        endpointB: "DC2",
        index: 0,
        purpose: "Backbone",
        status: "active",
      },
    },
    loopbacks: {
      "dc1-lo": {
        node: "DC1",
        index: 1,
        role: "Router",
        status: "active",
      },
    },
    anycastPrefixes: {
      svc: {
        region: "infra",
        nibbles: "ce",
        purpose: "Services",
        status: "active",
      },
    },
    anycastVips: {
      dns: {
        prefix48: "svc",
        hostPart: "53",
        service: "DNS",
        status: "active",
      },
    },
  };
}

/** Canonical v4 args: root 2602:f4fb/36 so the canonical nat64Prefix is in-root. */
function canonicalV4Args(): GlobalArgs {
  const args = minimalArgs();
  args.root = "2602:f4fb";
  args.v4 = {
    root: "23.164.68.0",
    rootLength: 24,
    nat64Prefix: "2602:f4fb:64::",
    allocations: {
      "nat64-pool": { size: 32, purpose: "NAT64 pool", status: "active" },
      "dns-vip": { size: 8, purpose: "DNS VIP", status: "active" },
      "ingress-vip": { size: 16, purpose: "Ingress VIP", status: "active" },
    },
  };
  return args;
}

// ---------------------------------------------------------------------------
// 1. Exact allocator layout (canonical input)
// ---------------------------------------------------------------------------

Deno.test("computePlan v4: canonical allocation layout is exact", () => {
  const plan = computePlan(canonicalV4Args());
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");

  const byKey = Object.fromEntries(v4.allocations.map((a) => [a.key, a]));

  assertEquals(byKey["dns-vip"].cidr, "23.164.68.8/29");
  assertEquals(byKey["dns-vip"].firstAddr, "23.164.68.8");
  assertEquals(byKey["dns-vip"].lastAddr, "23.164.68.15");

  assertEquals(byKey["ingress-vip"].cidr, "23.164.68.16/28");
  assertEquals(byKey["ingress-vip"].firstAddr, "23.164.68.16");
  assertEquals(byKey["ingress-vip"].lastAddr, "23.164.68.31");

  assertEquals(byKey["nat64-pool"].cidr, "23.164.68.32/27");
  assertEquals(byKey["nat64-pool"].firstAddr, "23.164.68.32");
  assertEquals(byKey["nat64-pool"].lastAddr, "23.164.68.63");
});

Deno.test("computePlan v4: canonical freeRanges deep-equal expected", () => {
  const plan = computePlan(canonicalV4Args());
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");

  assertEquals(v4.freeRanges, [
    { firstAddr: "23.164.68.1", lastAddr: "23.164.68.7", count: 7 },
    { firstAddr: "23.164.68.64", lastAddr: "23.164.68.254", count: 191 },
  ]);
});

Deno.test("computePlan v4: canonical counts are exact", () => {
  const plan = computePlan(canonicalV4Args());
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");

  assertEquals(v4.counts, {
    allocations: 3,
    usedAddresses: 56,
    freeAddresses: 198,
  });
});

Deno.test("computePlan v4: canonical nat64Prefix compressed and no v4 validation errors", () => {
  const plan = computePlan(canonicalV4Args());
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");

  assertEquals(v4.nat64Prefix, "2602:f4fb:64::/96");
  const v4Errors = plan.validationErrors.filter((e) => e.startsWith("IPv4:"));
  assertEquals(v4Errors, []);
});

// ---------------------------------------------------------------------------
// 2. ipv4ToInt / intToIpv4 round-trip + endianness
// ---------------------------------------------------------------------------

Deno.test("ipv4ToInt/intToIpv4: round-trip across edge values", () => {
  for (
    const dotted of [
      "0.0.0.0",
      "255.255.255.255",
      "23.164.68.255",
      "23.164.68.0",
    ]
  ) {
    assertEquals(intToIpv4(ipv4ToInt(dotted)), dotted);
  }
});

Deno.test("ipv4ToInt: 0.0.0.0 is integer 0", () => {
  assertEquals(ipv4ToInt("0.0.0.0"), 0);
});

Deno.test("ipv4ToInt: 255.255.255.255 is unsigned 4294967295 (not negative)", () => {
  assertEquals(ipv4ToInt("255.255.255.255"), 4294967295);
});

Deno.test("ipv4ToInt: big-endian — last octet is the ones place", () => {
  assertEquals(ipv4ToInt("23.164.68.1"), ipv4ToInt("23.164.68.0") + 1);
});

Deno.test("ipv4ToInt: big-endian — first octet carries the most significant byte", () => {
  // Incrementing the first octet must add exactly 2^24, not 1 or 2^8.
  assertEquals(ipv4ToInt("24.164.68.0") - ipv4ToInt("23.164.68.0"), 1 << 24);
});

// ---------------------------------------------------------------------------
// 3. nextPow2 edges
// ---------------------------------------------------------------------------

Deno.test("nextPow2: 1 -> 1", () => {
  assertEquals(nextPow2(1), 1);
});

Deno.test("nextPow2: exact power of two is unchanged (8 -> 8, not 16)", () => {
  assertEquals(nextPow2(8), 8);
});

Deno.test("nextPow2: non-power rounds up (17 -> 32)", () => {
  assertEquals(nextPow2(17), 32);
});

Deno.test("nextPow2: non-power rounds up (33 -> 64)", () => {
  assertEquals(nextPow2(33), 64);
});

Deno.test("computePlan v4: size-1 allocation yields a /32", () => {
  const args = minimalArgs();
  args.root = "2602:f4fb";
  args.v4 = {
    root: "23.164.68.0",
    rootLength: 24,
    nat64Prefix: "2602:f4fb:64::",
    allocations: {
      "single-host": { size: 1, purpose: "Single host", status: "active" },
    },
  };
  const plan = computePlan(args);
  const alloc = plan.v4?.allocations.find((a) => a.key === "single-host");
  assertEquals(alloc?.prefixLength, 32);
  assertEquals(alloc?.cidr.endsWith("/32"), true);
  assertEquals(alloc?.usableCount, 1);
});

// ---------------------------------------------------------------------------
// 4. .0 / .255 exclusion
// ---------------------------------------------------------------------------

Deno.test("computePlan v4: no allocation covers the network (.0) or broadcast (.255) address", () => {
  const plan = computePlan(canonicalV4Args());
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");

  const networkInt = ipv4ToInt("23.164.68.0");
  const broadcastInt = ipv4ToInt("23.164.68.255");

  for (const a of v4.allocations) {
    const first = ipv4ToInt(a.firstAddr);
    const last = ipv4ToInt(a.lastAddr);
    const coversNetwork = first <= networkInt && networkInt <= last;
    const coversBroadcast = first <= broadcastInt && broadcastInt <= last;
    assertEquals(
      coversNetwork,
      false,
      `allocation ${a.key} (${a.cidr}) covers the network address`,
    );
    assertEquals(
      coversBroadcast,
      false,
      `allocation ${a.key} (${a.cidr}) covers the broadcast address`,
    );
  }
});

Deno.test("computePlan v4: .0 and .255 never appear in freeRanges", () => {
  const plan = computePlan(canonicalV4Args());
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");

  for (const r of v4.freeRanges) {
    assertEquals(r.firstAddr === "23.164.68.0", false);
    assertEquals(r.lastAddr === "23.164.68.0", false);
    assertEquals(r.firstAddr === "23.164.68.255", false);
    assertEquals(r.lastAddr === "23.164.68.255", false);
  }
});

// ---------------------------------------------------------------------------
// 5. No overlap, ever
// ---------------------------------------------------------------------------

function assertAllDisjoint(
  allocations: Array<{ key: string; firstAddr: string; lastAddr: string }>,
) {
  const ranges = allocations.map((a) => ({
    key: a.key,
    start: ipv4ToInt(a.firstAddr),
    end: ipv4ToInt(a.lastAddr),
  }));
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];
      const overlaps = a.start <= b.end && b.start <= a.end;
      assertEquals(
        overlaps,
        false,
        `allocations ${a.key} and ${b.key} overlap`,
      );
    }
  }
}

Deno.test("computePlan v4: canonical allocations are pairwise disjoint", () => {
  const plan = computePlan(canonicalV4Args());
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");
  assertAllDisjoint(v4.allocations);
});

Deno.test("computePlan v4: four /26-ish requests remain pairwise disjoint", () => {
  const args = minimalArgs();
  args.root = "2602:f4fb";
  args.v4 = {
    root: "23.164.68.0",
    rootLength: 24,
    nat64Prefix: "2602:f4fb:64::",
    allocations: {
      "a-block": { size: 50, purpose: "A", status: "active" }, // -> /26 (64)
      "b-block": { size: 50, purpose: "B", status: "active" }, // -> /26 (64)
      "c-block": { size: 30, purpose: "C", status: "active" }, // -> /27 (32)
      "d-block": { size: 30, purpose: "D", status: "active" }, // -> /27 (32)
    },
  };
  const plan = computePlan(args);
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");

  // All four requests should fit (64+64+32+32 = 192 <= 254) — confirm none
  // were silently dropped before checking disjointness, otherwise this test
  // would pass vacuously.
  assertEquals(v4.allocations.length, 4);
  assertAllDisjoint(v4.allocations);
});

// ---------------------------------------------------------------------------
// 6. Over-subscription — unplaceable allocations are reported, not thrown
// ---------------------------------------------------------------------------

Deno.test("computePlan v4: oversubscribed /24 reports cannot-place errors and omits them from allocations", () => {
  const args = minimalArgs();
  args.root = "2602:f4fb";
  args.v4 = {
    root: "23.164.68.0",
    rootLength: 24,
    nat64Prefix: "2602:f4fb:64::",
    allocations: {
      "huge-a": { size: 200, purpose: "Huge A", status: "active" },
      "huge-b": { size: 200, purpose: "Huge B", status: "active" },
    },
  };

  // Must not throw.
  const plan = computePlan(args);
  const v4 = plan.v4;
  if (!v4) throw new Error("expected plan.v4 to be set");

  // nextPow2(200) = 256, which (minus the reserved network/broadcast
  // addresses) can never fit in a /24 — both requests are unplaceable.
  assertArrayIncludes(plan.validationErrors, [
    "IPv4: cannot place huge-a (/24)",
  ]);
  assertArrayIncludes(plan.validationErrors, [
    "IPv4: cannot place huge-b (/24)",
  ]);

  assertEquals(v4.allocations.find((a) => a.key === "huge-a"), undefined);
  assertEquals(v4.allocations.find((a) => a.key === "huge-b"), undefined);
  assertEquals(v4.allocations.length, 0);
  assertEquals(v4.counts.allocations, 0);
  assertEquals(v4.counts.usedAddresses, 0);
});

// ---------------------------------------------------------------------------
// 7. NAT64 containment
// ---------------------------------------------------------------------------

Deno.test("computePlan v4: nat64Prefix outside the v6 root produces a containment error", () => {
  const args = minimalArgs(); // root "3fff:0db8"/36
  args.v4 = {
    root: "23.164.68.0",
    rootLength: 24,
    nat64Prefix: "2001:db8::", // nowhere near 3fff:0db8::/36
    allocations: {
      "dns-vip": { size: 8, purpose: "DNS VIP", status: "active" },
    },
  };
  const plan = computePlan(args);
  const err = plan.validationErrors.find((e) =>
    e.startsWith("IPv4: nat64Prefix") && e.includes("is not within")
  );
  assertEquals(err !== undefined, true);
});

Deno.test("computePlan v4: nat64Prefix inside the v6 root produces no containment error", () => {
  const args = minimalArgs(); // root "3fff:0db8"/36
  args.v4 = {
    root: "23.164.68.0",
    rootLength: 24,
    nat64Prefix: "3fff:db8:64::", // within 3fff:0db8::/36
    allocations: {
      "dns-vip": { size: 8, purpose: "DNS VIP", status: "active" },
    },
  };
  const plan = computePlan(args);
  const err = plan.validationErrors.find((e) =>
    e.startsWith("IPv4: nat64Prefix")
  );
  assertEquals(err, undefined);
});

// ---------------------------------------------------------------------------
// 8. THE DRIFT INVARIANT — adding v4 must not perturb the v6 plan
// ---------------------------------------------------------------------------

Deno.test("computePlan v4: absent v4 arg leaves plan.v4 undefined", () => {
  const plan = computePlan(minimalArgs());
  assertEquals(plan.v4, undefined);
});

Deno.test("computePlan v4: adding a valid v4 block does not perturb the v6 output", () => {
  const argsNoV4 = minimalArgs();
  const argsWithV4: GlobalArgs = {
    ...argsNoV4,
    v4: {
      root: "23.164.68.0",
      rootLength: 24,
      // within 3fff:0db8::/36, so this does not add a v4 validation error
      // that would otherwise make the two plans differ.
      nat64Prefix: "3fff:db8:64::",
      allocations: {
        "dns-vip": { size: 8, purpose: "DNS VIP", status: "active" },
      },
    },
  };

  const planNoV4 = computePlan(argsNoV4);
  const planWithV4 = computePlan(argsWithV4);

  assertEquals(planNoV4.v4, undefined);

  // deno-lint-ignore no-explicit-any
  const strippedNoV4: any = { ...planNoV4 };
  delete strippedNoV4.v4;
  delete strippedNoV4.generatedAt;

  // deno-lint-ignore no-explicit-any
  const strippedWithV4: any = { ...planWithV4 };
  delete strippedWithV4.v4;
  delete strippedWithV4.generatedAt;

  assertEquals(strippedWithV4, strippedNoV4);
});
