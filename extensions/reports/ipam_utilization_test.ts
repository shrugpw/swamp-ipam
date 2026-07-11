import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { report } from "./ipam_utilization.ts";
import type { PlanSummary, ReportContext } from "../models/ipam.ts";

function makePlan(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    root: "3fff:0db8",
    rootLength: 36,
    generatedAt: "2026-07-11T00:00:00.000Z",
    counts: { regions: 2, sites: 3, subnets: 2, tunnels: 2, loopbacks: 2, anycastPrefixes: 0, anycastVips: 0 },
    validationErrors: [],
    blocks: [
      { key: "east", nibble: "a", prefix: "3fff:db8:a00::/40", prefixLength: 40, purpose: "US East", status: "active", siteCount: 2 },
      { key: "west", nibble: "b", prefix: "3fff:db8:b00::/40", prefixLength: 40, purpose: "US West", status: "planned", siteCount: 1 },
    ],
    sites: [
      { key: "ash1", region: "east", slotNibble: "1", name: "Ashburn 1", location: "VA", provider: "Equinix", envelope: "3fff:db8:a10::/44", envelopeLength: 44, prefix: "3fff:db8:a10::/48", prefixLength: 48, status: "active", subnetCount: 2 },
      { key: "ash2", region: "east", slotNibble: "2", name: "Ashburn 2", location: "VA", provider: "Equinix", envelope: "3fff:db8:a20::/44", envelopeLength: 44, prefix: "3fff:db8:a20::/48", prefixLength: 48, status: "active", subnetCount: 1 },
      { key: "lax1", region: "west", slotNibble: "1", name: "Los Angeles 1", location: "CA", provider: "CoreSite", envelope: "3fff:db8:b10::/44", envelopeLength: 44, prefix: "3fff:db8:b10::/48", prefixLength: 48, status: "planned", subnetCount: 0 },
    ],
    subnets: [
      { key: "ash1-mgmt", site: "ash1", vlan: 10, prefix: "3fff:db8:a10:a::/64", prefixLength: 64, purpose: "Management", status: "active" },
      { key: "ash1-srv", site: "ash1", vlan: 20, prefix: "3fff:db8:a10:14::/64", prefixLength: 64, purpose: "Servers", status: "active" },
    ],
    tunnels: [
      { key: "ash1-lax1", endpointA: "ash1", endpointB: "lax1", prefix: "3fff:db8:a00:ffff::/126", prefixLength: 126, addrA: "3fff:db8:a00:ffff::1", addrB: "3fff:db8:a00:ffff::2", purpose: "Core", status: "active" },
      { key: "ash1-ash2", endpointA: "ash1", endpointB: "ash2", prefix: "3fff:db8:a00:ffff::8/126", prefixLength: 126, addrA: "3fff:db8:a00:ffff::9", addrB: "3fff:db8:a00:ffff::a", purpose: "Metro", status: "active" },
    ],
    loopbacks: [
      { key: "ash1-lo", node: "ash1", address: "3fff:db8:a00:ffff::1:0", prefixLength: 128, role: "router-id", status: "active" },
      { key: "lax1-lo", node: "lax1", address: "3fff:db8:a00:ffff::1:2", prefixLength: 128, role: "router-id", status: "planned" },
    ],
    anycastVips: [],
    ...overrides,
  };
}

function makeContext(plan: PlanSummary | null): ReportContext {
  return {
    modelType: "@shrug/ipam",
    modelId: "test-id",
    dataRepository: {
      getContent: async () =>
        plan ? new TextEncoder().encode(JSON.stringify(plan)) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// No plan data
// ---------------------------------------------------------------------------

Deno.test("ipam-utilization: returns placeholder when no plan data", async () => {
  const result = await report.execute(makeContext(null));
  assertStringIncludes(result.markdown, "No plan data yet");
  assertEquals(result.json, { error: "no plan data" });
});

// ---------------------------------------------------------------------------
// Region capacity
// ---------------------------------------------------------------------------

Deno.test("ipam-utilization: computes region slot usage", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  const regions = json.regions as Array<Record<string, unknown>>;

  const east = regions.find((r) => r.key === "east")!;
  assertEquals(east.slotsUsed, 2);
  assertEquals(east.slotsTotal, 16);
  assertEquals(east.pct, 13);

  const west = regions.find((r) => r.key === "west")!;
  assertEquals(west.slotsUsed, 1);
  assertEquals(west.pct, 6);
});

Deno.test("ipam-utilization: region with no sites shows 0%", async () => {
  const plan = makePlan({
    blocks: [{ key: "empty", nibble: "c", prefix: "3fff:db8:c00::/40", prefixLength: 40, purpose: "Reserved", status: "reserved", siteCount: 0 }],
    sites: [],
  });
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  const regions = json.regions as Array<Record<string, unknown>>;
  assertEquals(regions[0].slotsUsed, 0);
  assertEquals(regions[0].pct, 0);
});

// ---------------------------------------------------------------------------
// Site subnet counts
// ---------------------------------------------------------------------------

Deno.test("ipam-utilization: lists site subnet counts from plan data", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  const sites = json.sites as Array<Record<string, unknown>>;

  const ash1 = sites.find((s) => s.key === "ash1")!;
  assertEquals(ash1.subnetsAllocated, 2);
  assertEquals(ash1.region, "east");

  const lax1 = sites.find((s) => s.key === "lax1")!;
  assertEquals(lax1.subnetsAllocated, 0);
});

// ---------------------------------------------------------------------------
// Index gap detection
// ---------------------------------------------------------------------------

Deno.test("ipam-utilization: detects tunnel index gaps", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  const tunnelGaps = json.tunnelGaps as Record<string, unknown>;
  assertEquals(tunnelGaps.resource, "tunnels");
  assertEquals(Array.isArray(tunnelGaps.usedIndices), true);
});

Deno.test("ipam-utilization: detects loopback index gaps", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  const loopbackGaps = json.loopbackGaps as Record<string, unknown>;
  assertEquals(loopbackGaps.resource, "loopbacks");

  const gaps = loopbackGaps.gaps as number[];
  const used = loopbackGaps.usedIndices as number[];
  // indices 0 and 2 → gap at 1
  assertEquals(used, [0, 2]);
  assertEquals(gaps, [1]);
  assertEquals(loopbackGaps.nextFree, 3);
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

Deno.test("ipam-utilization: markdown contains region table", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "Region Capacity");
  assertStringIncludes(result.markdown, "US East");
  assertStringIncludes(result.markdown, "US West");
});

Deno.test("ipam-utilization: markdown contains site subnet table", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "Site Subnet Count");
  assertStringIncludes(result.markdown, "Ashburn 1");
});

Deno.test("ipam-utilization: markdown contains index pool section", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "Index Pool Gaps");
  assertStringIncludes(result.markdown, "tunnels");
  assertStringIncludes(result.markdown, "loopbacks");
  assertStringIncludes(result.markdown, "Next free index");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("ipam-utilization: empty tunnels/loopbacks yields no gaps", async () => {
  const plan = makePlan({ tunnels: [], loopbacks: [] });
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  const tunnelGaps = json.tunnelGaps as Record<string, unknown>;
  assertEquals(tunnelGaps.usedIndices, []);
  assertEquals(tunnelGaps.gaps, []);
  assertEquals(tunnelGaps.nextFree, 0);
});

Deno.test("ipam-utilization: report metadata is correct", () => {
  assertEquals(report.name, "@shrug/ipam-utilization");
  assertEquals(report.scope, "model");
});
