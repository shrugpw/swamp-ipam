import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { report } from "./ipam_report.ts";
import type { PlanSummary, ReportContext } from "../models/ipam.ts";

function makePlan(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    root: "3fff:0db8",
    rootLength: 36,
    generatedAt: "2026-07-11T00:00:00.000Z",
    counts: { regions: 1, sites: 1, subnets: 1, tunnels: 1, loopbacks: 1, anycastPrefixes: 1, anycastVips: 1 },
    validationErrors: [],
    blocks: [{
      key: "east", nibble: "a", prefix: "3fff:db8:a00::/40",
      prefixLength: 40, purpose: "US East", status: "active", siteCount: 1,
    }],
    sites: [{
      key: "ash1", region: "east", slotNibble: "1", name: "Ashburn 1",
      location: "VA", provider: "Equinix", envelope: "3fff:db8:a10::/44",
      envelopeLength: 44, prefix: "3fff:db8:a10::/48", prefixLength: 48,
      status: "active", subnetCount: 1,
    }],
    subnets: [{
      key: "ash1-mgmt", site: "ash1", vlan: 10, prefix: "3fff:db8:a10:a::/64",
      prefixLength: 64, purpose: "Management", status: "active",
    }],
    tunnels: [{
      key: "ash1-hel1", endpointA: "ash1", endpointB: "hel1",
      prefix: "3fff:db8:a00:ffff::/126", prefixLength: 126,
      addrA: "3fff:db8:a00:ffff::1", addrB: "3fff:db8:a00:ffff::2",
      purpose: "Core link", status: "active",
    }],
    loopbacks: [{
      key: "ash1-lo", node: "ash1", address: "3fff:db8:a00:ffff::1:0",
      prefixLength: 128, role: "router-id", status: "active",
    }],
    anycastVips: [{
      key: "dns", prefix48: "3fff:db8:a10::", address: "3fff:db8:a10::53",
      service: "DNS", status: "active",
    }],
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

Deno.test("ipam-report: returns placeholder when no plan data", async () => {
  const result = await report.execute(makeContext(null));
  assertStringIncludes(result.markdown, "No plan data yet");
  assertEquals(result.json, { error: "no plan data" });
});

// ---------------------------------------------------------------------------
// Normal plan rendering
// ---------------------------------------------------------------------------

Deno.test("ipam-report: returns markdown with region/site/subnet tables", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "# IPv6 Address Plan");
  assertStringIncludes(result.markdown, "east");
  assertStringIncludes(result.markdown, "Ashburn 1");
  assertStringIncludes(result.markdown, "3fff:db8:a10:a::/64");
});

Deno.test("ipam-report: markdown includes tunnel section", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "Tunnel P2P Links");
  assertStringIncludes(result.markdown, "ash1-hel1");
  assertStringIncludes(result.markdown, "3fff:db8:a00:ffff::/126");
});

Deno.test("ipam-report: markdown includes loopback section", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "Loopback Addresses");
  assertStringIncludes(result.markdown, "ash1");
  assertStringIncludes(result.markdown, "router-id");
});

Deno.test("ipam-report: markdown includes anycast section", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "DNS");
  assertStringIncludes(result.markdown, "3fff:db8:a10::53");
});

Deno.test("ipam-report: json includes topology mermaid", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  assertEquals(typeof (result.json as Record<string, unknown>).topologyMermaid, "string");
  assertStringIncludes(
    (result.json as Record<string, unknown>).topologyMermaid as string,
    "graph",
  );
});

Deno.test("ipam-report: json includes counts and metadata", async () => {
  const plan = makePlan();
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  assertEquals(json.root, "3fff:0db8");
  assertEquals(json.rootLength, 36);
  assertEquals(json.generatedAt, "2026-07-11T00:00:00.000Z");
  assertEquals((json.counts as Record<string, number>).regions, 1);
});

Deno.test("ipam-report: validation errors appear in json", async () => {
  const plan = makePlan({ validationErrors: ["overlap: block:east ⊇ block:west"] });
  const result = await report.execute(makeContext(plan));
  const json = result.json as Record<string, unknown>;
  assertEquals(json.validationErrors, ["overlap: block:east ⊇ block:west"]);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("ipam-report: empty plan (no resources) renders without error", async () => {
  const plan = makePlan({
    counts: { regions: 0, sites: 0, subnets: 0, tunnels: 0, loopbacks: 0, anycastPrefixes: 0, anycastVips: 0 },
    blocks: [], sites: [], subnets: [], tunnels: [], loopbacks: [], anycastVips: [],
  });
  const result = await report.execute(makeContext(plan));
  assertStringIncludes(result.markdown, "# IPv6 Address Plan");
  assertEquals((result.json as Record<string, unknown>).root, "3fff:0db8");
});

Deno.test("ipam-report: report metadata is correct", () => {
  assertEquals(report.name, "@shrug/ipam-report");
  assertEquals(report.scope, "model");
});
