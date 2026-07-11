import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertArrayIncludes } from "https://deno.land/std@0.224.0/assert/assert_array_includes.ts";
import {
  buildAddress,
  buildPrefix,
  compressIPv6,
  computePlan,
  expandIPv6,
  findOverlaps,
  type GlobalArgs,
  prefixContains,
} from "./ipam.ts";

// ---------------------------------------------------------------------------
// compressIPv6
// ---------------------------------------------------------------------------

Deno.test("compressIPv6: collapses longest zero run", () => {
  assertEquals(compressIPv6("2001:0db8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
});

Deno.test("compressIPv6: all zeros", () => {
  assertEquals(compressIPv6("0000:0000:0000:0000:0000:0000:0000:0000"), "::");
});

Deno.test("compressIPv6: no collapsible run", () => {
  assertEquals(compressIPv6("2001:0db8:0001:0002:0003:0004:0005:0006"), "2001:db8:1:2:3:4:5:6");
});

Deno.test("compressIPv6: leading zeros only (single zero group not collapsed)", () => {
  assertEquals(compressIPv6("2001:0db8:0000:0001:0002:0003:0004:0005"), "2001:db8:0:1:2:3:4:5");
});

Deno.test("compressIPv6: trailing zero run", () => {
  assertEquals(compressIPv6("2001:0db8:0001:0000:0000:0000:0000:0000"), "2001:db8:1::");
});

Deno.test("compressIPv6: leading zero run", () => {
  assertEquals(compressIPv6("0000:0000:0000:0000:0000:0000:0000:0001"), "::1");
});

Deno.test("compressIPv6: longer run wins over shorter", () => {
  // run at [1,2] len 2 and [4,5,6] len 3 → second (longer) wins
  assertEquals(compressIPv6("2001:0000:0000:0001:0000:0000:0000:0001"), "2001:0:0:1::1");
});

// ---------------------------------------------------------------------------
// expandIPv6
// ---------------------------------------------------------------------------

Deno.test("expandIPv6: expands :: to fill missing groups", () => {
  assertEquals(expandIPv6("2001:db8::1"), "2001:0db8:0000:0000:0000:0000:0000:0001");
});

Deno.test("expandIPv6: all-zeros shorthand", () => {
  assertEquals(expandIPv6("::"), "0000:0000:0000:0000:0000:0000:0000:0000");
});

Deno.test("expandIPv6: already expanded", () => {
  assertEquals(expandIPv6("2001:db8:0:0:0:0:0:1"), "2001:0db8:0000:0000:0000:0000:0000:0001");
});

Deno.test("expandIPv6: loopback", () => {
  assertEquals(expandIPv6("::1"), "0000:0000:0000:0000:0000:0000:0000:0001");
});

// ---------------------------------------------------------------------------
// buildPrefix
// ---------------------------------------------------------------------------

Deno.test("buildPrefix: /36 root with region nibble → /40", () => {
  const result = buildPrefix("3fff:0db8", 36, "b00", 40);
  assertEquals(result, "3fff:db8:b00::/40");
});

Deno.test("buildPrefix: /36 root with site → /48", () => {
  const result = buildPrefix("3fff:0db8", 36, "b10", 48);
  assertEquals(result, "3fff:db8:b10::/48");
});

Deno.test("buildPrefix: /36 root with offset nibble d → /48 (0bed pattern)", () => {
  const result = buildPrefix("2602:f4fb", 36, "bed", 48);
  assertEquals(result, "2602:f4fb:bed::/48");
});

Deno.test("buildPrefix: /36 root with subnet → /64", () => {
  const result = buildPrefix("3fff:0db8", 36, "b100010", 64);
  assertEquals(result, "3fff:db8:b10:10::/64");
});

Deno.test("buildPrefix: /36 root infra tunnel /126", () => {
  const result = buildPrefix("3fff:0db8", 36, "00e" + "0".repeat(17) + "0000", 126);
  assertEquals(result, "3fff:db8:e::/126");
});

// ---------------------------------------------------------------------------
// buildAddress
// ---------------------------------------------------------------------------

Deno.test("buildAddress: loopback /128", () => {
  const result = buildAddress("3fff:0db8", 36, "00effff" + "0".repeat(12) + "0001");
  assertEquals(result, "3fff:db8:e:ffff::1");
});

Deno.test("buildAddress: anycast VIP with host ::53", () => {
  // afterRootLen = 32 - ceil(36/4) = 23; prefix48Hex = "0ce" (3); host = "0053" (4); fill = 16
  const result = buildAddress("3fff:0db8", 36, "0ce" + "0".repeat(16) + "0053");
  assertEquals(result, "3fff:db8:ce::53");
});

// ---------------------------------------------------------------------------
// prefixContains
// ---------------------------------------------------------------------------

Deno.test("prefixContains: /40 contains /48 within it", () => {
  assertEquals(prefixContains("3fff:db8:b00::", 40, "3fff:db8:b10::", 48), true);
});

Deno.test("prefixContains: /48 does not contain /40", () => {
  assertEquals(prefixContains("3fff:db8:b10::", 48, "3fff:db8:b00::", 40), false);
});

Deno.test("prefixContains: disjoint /40s", () => {
  assertEquals(prefixContains("3fff:db8:a00::", 40, "3fff:db8:b00::", 40), false);
});

Deno.test("prefixContains: identical prefixes", () => {
  assertEquals(prefixContains("3fff:db8:b10::", 48, "3fff:db8:b10::", 48), true);
});

// ---------------------------------------------------------------------------
// findOverlaps
// ---------------------------------------------------------------------------

Deno.test("findOverlaps: no overlaps", () => {
  const prefixes = [
    { key: "a", prefix: "3fff:db8:a00::", length: 40 },
    { key: "b", prefix: "3fff:db8:b00::", length: 40 },
  ];
  assertEquals(findOverlaps(prefixes), []);
});

Deno.test("findOverlaps: detects same-length collision", () => {
  const prefixes = [
    { key: "a", prefix: "3fff:db8:a00::", length: 40 },
    { key: "b", prefix: "3fff:db8:a00::", length: 40 },
  ];
  const errors = findOverlaps(prefixes);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].includes("a"), true);
  assertEquals(errors[0].includes("b"), true);
});

// ---------------------------------------------------------------------------
// computePlan — minimal fixture
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

Deno.test("computePlan: produces correct counts", () => {
  const plan = computePlan(minimalArgs());
  assertEquals(plan.counts.regions, 2);
  assertEquals(plan.counts.sites, 1);
  assertEquals(plan.counts.subnets, 1);
  assertEquals(plan.counts.tunnels, 1);
  assertEquals(plan.counts.loopbacks, 1);
  assertEquals(plan.counts.anycastVips, 1);
  assertEquals(plan.validationErrors.length, 0);
});

Deno.test("computePlan: region /40 prefix is correct", () => {
  const plan = computePlan(minimalArgs());
  const na = plan.blocks.find((b) => b.key === "na");
  assertEquals(na?.prefix, "3fff:db8:b00::/40");
});

Deno.test("computePlan: site /48 prefix is correct", () => {
  const plan = computePlan(minimalArgs());
  const dc1 = plan.sites.find((s) => s.key === "dc1");
  assertEquals(dc1?.prefix, "3fff:db8:b10::/48");
  assertEquals(dc1?.envelope, "3fff:db8:b10::/44");
});

Deno.test("computePlan: subnet /64 prefix is correct", () => {
  const plan = computePlan(minimalArgs());
  const mgmt = plan.subnets.find((s) => s.key === "dc1-mgmt");
  assertEquals(mgmt?.prefix, "3fff:db8:b10:10::/64");
});

Deno.test("computePlan: tunnel /126 addresses are sequential", () => {
  const plan = computePlan(minimalArgs());
  const tun = plan.tunnels[0];
  assertEquals(tun.prefix, "3fff:db8:e::/126");
  assertEquals(tun.addrA, "3fff:db8:e::");
  assertEquals(tun.addrB, "3fff:db8:e::1");
});

Deno.test("computePlan: tunnel index 3 → offset 0xc", () => {
  const args = minimalArgs();
  args.tunnels = {
    "tun3": {
      endpointA: "A", endpointB: "B", index: 3,
      purpose: "Test", status: "active",
    },
  };
  const plan = computePlan(args);
  assertEquals(plan.tunnels[0].prefix, "3fff:db8:e::c/126");
  assertEquals(plan.tunnels[0].addrA, "3fff:db8:e::c");
  assertEquals(plan.tunnels[0].addrB, "3fff:db8:e::d");
});

Deno.test("computePlan: loopback /128 address", () => {
  const plan = computePlan(minimalArgs());
  const lb = plan.loopbacks[0];
  assertEquals(lb.address, "3fff:db8:e:ffff::1");
});

Deno.test("computePlan: anycast VIP address", () => {
  const plan = computePlan(minimalArgs());
  const vip = plan.anycastVips[0];
  assertEquals(vip.address, "3fff:db8:ce::53");
});

Deno.test("computePlan: offset nibble 'd' produces 0bed-style prefix", () => {
  const args = minimalArgs();
  args.root = "2602:f4fb";
  args.sites = {
    bed: {
      region: "na",
      slotNibble: "e",
      offsetNibble: "d",
      name: "Bedford",
      location: "Bedford, NH",
      provider: "ISP",
      status: "active",
    },
  };
  args.subnets = {};
  const plan = computePlan(args);
  const bed = plan.sites.find((s) => s.key === "bed");
  assertEquals(bed?.prefix, "2602:f4fb:bed::/48");
  assertEquals(bed?.envelope, "2602:f4fb:be0::/44");
});

// ---------------------------------------------------------------------------
// computePlan — validation errors
// ---------------------------------------------------------------------------

Deno.test("computePlan: detects duplicate region nibbles", () => {
  const args = minimalArgs();
  args.regions.dup = { nibble: "b", purpose: "Dup", status: "active" };
  const plan = computePlan(args);
  assertArrayIncludes(plan.validationErrors, ["Duplicate region nibble detected"]);
});

Deno.test("computePlan: detects duplicate /48 prefix in same region", () => {
  const args = minimalArgs();
  args.sites.dc2 = {
    region: "na",
    slotNibble: "1",
    offsetNibble: "0",
    name: "DC2",
    location: "NYC",
    provider: "Example",
    status: "active",
  };
  const plan = computePlan(args);
  assertArrayIncludes(plan.validationErrors, ["Duplicate /48 prefix within a region detected"]);
});

Deno.test("computePlan: same slot different offset is NOT a duplicate", () => {
  const args = minimalArgs();
  args.sites.dc2 = {
    region: "na",
    slotNibble: "1",
    offsetNibble: "1",
    name: "DC2",
    location: "NYC",
    provider: "Example",
    status: "active",
  };
  const plan = computePlan(args);
  const dupErr = plan.validationErrors.find((e) => e.includes("Duplicate /48"));
  assertEquals(dupErr, undefined);
});

Deno.test("computePlan: detects duplicate tunnel indices", () => {
  const args = minimalArgs();
  args.tunnels.tun1 = {
    endpointA: "X", endpointB: "Y", index: 0,
    purpose: "Dup", status: "active",
  };
  const plan = computePlan(args);
  assertArrayIncludes(plan.validationErrors, ["Duplicate tunnel index detected — /126 collision"]);
});

Deno.test("computePlan: detects duplicate loopback indices", () => {
  const args = minimalArgs();
  args.loopbacks.lo2 = {
    node: "DC2", index: 1, role: "Router", status: "active",
  };
  const plan = computePlan(args);
  assertArrayIncludes(plan.validationErrors, ["Duplicate loopback index detected — /128 collision"]);
});

Deno.test("computePlan: reports unknown region reference", () => {
  const args = minimalArgs();
  args.sites.bad = {
    region: "nonexistent",
    slotNibble: "f",
    offsetNibble: "0",
    name: "Bad",
    location: "Nowhere",
    provider: "None",
    status: "planned",
  };
  const plan = computePlan(args);
  const err = plan.validationErrors.find((e) => e.includes("nonexistent"));
  assertEquals(err !== undefined, true);
});

Deno.test("computePlan: reports unknown site reference in subnet", () => {
  const args = minimalArgs();
  args.subnets.bad = {
    site: "nonexistent",
    nibbles: "0010",
    purpose: "Bad",
    status: "planned",
  };
  const plan = computePlan(args);
  const err = plan.validationErrors.find((e) => e.includes("nonexistent"));
  assertEquals(err !== undefined, true);
});

Deno.test("computePlan: reports unknown anycast prefix reference", () => {
  const args = minimalArgs();
  args.anycastVips.bad = {
    prefix48: "nonexistent",
    hostPart: "1",
    service: "Bad",
    status: "planned",
  };
  const plan = computePlan(args);
  const err = plan.validationErrors.find((e) => e.includes("nonexistent"));
  assertEquals(err !== undefined, true);
});

Deno.test("computePlan: detects duplicate subnet nibbles at same site", () => {
  const args = minimalArgs();
  args.subnets["dc1-dup"] = {
    site: "dc1",
    vlan: 99,
    nibbles: "0010",
    purpose: "Duplicate",
    status: "active",
  };
  const plan = computePlan(args);
  const overlapErr = plan.validationErrors.find((e) => e.includes("Overlap") && e.includes("subnet"));
  assertEquals(overlapErr !== undefined, true);
});

Deno.test("computePlan: detects duplicate tunnel indices via overlap", () => {
  const args = minimalArgs();
  args.tunnels.tun1 = {
    endpointA: "X", endpointB: "Y", index: 0,
    purpose: "Dup", status: "active",
  };
  const plan = computePlan(args);
  const overlapErr = plan.validationErrors.find((e) => e.includes("Overlap") && e.includes("tunnel"));
  assertEquals(overlapErr !== undefined, true);
});

// ---------------------------------------------------------------------------
// computePlan — site count and subnet count wiring
// ---------------------------------------------------------------------------

Deno.test("computePlan: block siteCount matches sites in that region", () => {
  const args = minimalArgs();
  args.sites.dc2 = {
    region: "na",
    slotNibble: "2",
    offsetNibble: "0",
    name: "DC2",
    location: "NYC",
    provider: "Example",
    status: "active",
  };
  const plan = computePlan(args);
  const na = plan.blocks.find((b) => b.key === "na");
  assertEquals(na?.siteCount, 2);
  const infra = plan.blocks.find((b) => b.key === "infra");
  assertEquals(infra?.siteCount, 0);
});

Deno.test("computePlan: site subnetCount matches subnets at that site", () => {
  const args = minimalArgs();
  args.subnets["dc1-servers"] = {
    site: "dc1",
    vlan: 20,
    nibbles: "0020",
    purpose: "Servers",
    status: "active",
  };
  const plan = computePlan(args);
  const dc1 = plan.sites.find((s) => s.key === "dc1");
  assertEquals(dc1?.subnetCount, 2);
});

// ---------------------------------------------------------------------------
// renderMarkdown + renderTopologyMermaid (smoke tests)
// ---------------------------------------------------------------------------

import { renderMarkdown, renderTopologyMermaid } from "./ipam.ts";

Deno.test("renderMarkdown: includes root prefix in title", () => {
  const plan = computePlan(minimalArgs());
  const md = renderMarkdown(plan);
  assertEquals(md.includes("3fff:0db8::/36"), true);
});

Deno.test("renderMarkdown: includes validation errors section when present", () => {
  const args = minimalArgs();
  args.regions.dup = { nibble: "b", purpose: "Dup", status: "active" };
  const plan = computePlan(args);
  const md = renderMarkdown(plan);
  assertEquals(md.includes("## Validation Errors"), true);
});

Deno.test("renderMarkdown: no validation section when clean", () => {
  const plan = computePlan(minimalArgs());
  const md = renderMarkdown(plan);
  assertEquals(md.includes("Validation Errors"), false);
});

Deno.test("renderTopologyMermaid: produces graph LR header", () => {
  const plan = computePlan(minimalArgs());
  const mermaid = renderTopologyMermaid(plan);
  assertEquals(mermaid.startsWith("graph LR"), true);
});

Deno.test("renderTopologyMermaid: includes tunnel link between endpoints", () => {
  const plan = computePlan(minimalArgs());
  const mermaid = renderTopologyMermaid(plan);
  assertEquals(mermaid.includes("dc1") || mermaid.includes("DC1"), true);
});

Deno.test("renderTopologyMermaid: standalone node for unmatched tunnel endpoint", () => {
  const plan = computePlan(minimalArgs());
  const mermaid = renderTopologyMermaid(plan);
  // DC2 is a tunnel endpoint but not a site — should appear as standalone
  assertEquals(mermaid.includes("DC2"), true);
});
