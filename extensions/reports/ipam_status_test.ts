import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { report } from "./ipam_status.ts";
import type { PlanSummary, ReportContext } from "../models/ipam.ts";

function makePlan(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    root: "3fff:0db8",
    rootLength: 36,
    generatedAt: "2026-07-11T00:00:00.000Z",
    counts: { regions: 2, sites: 2, subnets: 2, tunnels: 1, loopbacks: 2, anycastPrefixes: 1, anycastVips: 1 },
    validationErrors: [],
    blocks: [
      { key: "east", nibble: "a", prefix: "3fff:db8:a00::/40", prefixLength: 40, purpose: "US East", status: "active", siteCount: 1 },
      { key: "reserve", nibble: "f", prefix: "3fff:db8:f00::/40", prefixLength: 40, purpose: "Future", status: "reserved", siteCount: 0 },
    ],
    sites: [
      { key: "ash1", region: "east", slotNibble: "1", name: "Ashburn 1", location: "VA", provider: "Equinix", envelope: "3fff:db8:a10::/44", envelopeLength: 44, prefix: "3fff:db8:a10::/48", prefixLength: 48, status: "active", subnetCount: 2 },
      { key: "lax1", region: "east", slotNibble: "2", name: "Los Angeles 1", location: "CA", provider: "CoreSite", envelope: "3fff:db8:a20::/44", envelopeLength: 44, prefix: "3fff:db8:a20::/48", prefixLength: 48, status: "planned", subnetCount: 0 },
    ],
    subnets: [
      { key: "ash1-mgmt", site: "ash1", vlan: 10, prefix: "3fff:db8:a10:a::/64", prefixLength: 64, purpose: "Management", status: "active" },
      { key: "ash1-srv", site: "ash1", vlan: 20, prefix: "3fff:db8:a10:14::/64", prefixLength: 64, purpose: "Servers", status: "planned" },
    ],
    tunnels: [
      { key: "ash1-lax1", endpointA: "ash1", endpointB: "lax1", prefix: "3fff:db8:a00:ffff::/126", prefixLength: 126, addrA: "3fff:db8:a00:ffff::1", addrB: "3fff:db8:a00:ffff::2", purpose: "Core", status: "active" },
    ],
    loopbacks: [
      { key: "ash1-lo", node: "ash1", address: "3fff:db8:a00:ffff::1:0", prefixLength: 128, role: "router-id", status: "active" },
      { key: "lax1-lo", node: "lax1", address: "3fff:db8:a00:ffff::1:1", prefixLength: 128, role: "router-id", status: "planned" },
    ],
    anycastVips: [
      { key: "dns", prefix48: "3fff:db8:a10::", address: "3fff:db8:a10::53", service: "DNS", status: "active" },
    ],
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

Deno.test("ipam-status: returns placeholder when no plan data", async () => {
  const result = await report.execute(makeContext(null));
  assertStringIncludes(result.markdown, "No plan data yet");
  assertEquals(result.json, { error: "no plan data" });
});

// ---------------------------------------------------------------------------
// Status grouping
// ---------------------------------------------------------------------------

Deno.test("ipam-status: groups resources by status correctly", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;

  const active = json.active as Array<Record<string, unknown>>;
  const planned = json.planned as Array<Record<string, unknown>>;
  const reserved = json.reserved as Array<Record<string, unknown>>;

  // active: east region, ash1 site, ash1-mgmt subnet, ash1-lax1 tunnel, ash1-lo loopback, dns vip = 6
  assertEquals(active.length, 6);
  // planned: lax1 site, ash1-srv subnet, lax1-lo loopback = 3
  assertEquals(planned.length, 3);
  // reserved: reserve region = 1
  assertEquals(reserved.length, 1);
});

Deno.test("ipam-status: totals sum correctly", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  const totals = json.totals as Record<string, number>;

  assertEquals(totals.active, 6);
  assertEquals(totals.planned, 3);
  assertEquals(totals.reserved, 1);
});

Deno.test("ipam-status: entries contain correct fields", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  const active = json.active as Array<Record<string, unknown>>;

  const region = active.find((e) => e.resource === "region")!;
  assertEquals(region.key, "east");
  assertEquals(region.label, "US East");
  assertEquals(region.prefix, "3fff:db8:a00::/40");

  const tunnel = active.find((e) => e.resource === "tunnel")!;
  assertEquals(tunnel.key, "ash1-lax1");
  assertEquals(tunnel.label, "ash1 ↔ lax1");

  const vip = active.find((e) => e.resource === "anycast-vip")!;
  assertEquals(vip.key, "dns");
  assertEquals(vip.label, "DNS");
  assertEquals(vip.prefix, "3fff:db8:a10::53");
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

Deno.test("ipam-status: markdown contains totals table", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "## Totals");
  assertStringIncludes(result.markdown, "| active | 6 |");
  assertStringIncludes(result.markdown, "| planned | 3 |");
  assertStringIncludes(result.markdown, "| reserved | 1 |");
});

Deno.test("ipam-status: markdown renders Active section with count", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "### Active (6)");
});

Deno.test("ipam-status: markdown renders Planned section", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "### Planned (3)");
  assertStringIncludes(result.markdown, "Los Angeles 1");
});

Deno.test("ipam-status: markdown renders Reserved section", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "### Reserved (1)");
  assertStringIncludes(result.markdown, "Future");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("ipam-status: empty plan groups are omitted from markdown", async () => {
  const plan = makePlan({
    blocks: [{ key: "east", nibble: "a", prefix: "3fff:db8:a00::/40", prefixLength: 40, purpose: "US East", status: "active", siteCount: 0 }],
    sites: [], subnets: [], tunnels: [], loopbacks: [], anycastVips: [],
  });
  const result = await report.execute(makeContext(plan));
  // Only active, no planned or reserved sections
  assertStringIncludes(result.markdown, "### Active (1)");
  assertEquals(result.markdown.includes("### Planned"), false);
  assertEquals(result.markdown.includes("### Reserved"), false);
});

Deno.test("ipam-status: all-planned plan has no active section", async () => {
  const plan = makePlan({
    blocks: [{ key: "west", nibble: "b", prefix: "3fff:db8:b00::/40", prefixLength: 40, purpose: "US West", status: "planned", siteCount: 0 }],
    sites: [], subnets: [], tunnels: [], loopbacks: [], anycastVips: [],
  });
  const result = await report.execute(makeContext(plan));
  assertEquals(result.markdown.includes("### Active"), false);
  assertStringIncludes(result.markdown, "### Planned (1)");
});

Deno.test("ipam-status: report metadata is correct", () => {
  assertEquals(report.name, "@shrug/ipam-status");
  assertEquals(report.scope, "model");
});
