/**
 * Utilization report for `@shrug/ipam`.
 *
 * Shows capacity usage: /44 slots per region, /64 subnets per site,
 * tunnel index gaps, and loopback index gaps.
 *
 * @module
 */
import {
  type PlanSummary,
  readLatestPlan,
  type ReportContext,
} from "../models/ipam.ts";

/** Max /44 slots per /40 region (one hex nibble = 16 values). */
const MAX_SLOTS_PER_REGION = 16;

interface RegionUtil {
  key: string;
  purpose: string;
  status: string;
  slotsUsed: number;
  slotsTotal: number;
  pct: number;
}

interface SiteUtil {
  key: string;
  name: string;
  region: string;
  subnetsAllocated: number;
  status: string;
}

interface IndexGap {
  resource: string;
  usedIndices: number[];
  gaps: number[];
  nextFree: number;
}

interface UtilizationJson {
  generatedAt: string;
  regions: RegionUtil[];
  sites: SiteUtil[];
  tunnelGaps: IndexGap;
  loopbackGaps: IndexGap;
}

function computeUtilization(plan: PlanSummary): UtilizationJson {
  const regions: RegionUtil[] = plan.blocks.map((b) => {
    const slotsUsed = plan.sites.filter((s) => s.region === b.key).length;
    return {
      key: b.key,
      purpose: b.purpose,
      status: b.status,
      slotsUsed,
      slotsTotal: MAX_SLOTS_PER_REGION,
      pct: Math.round((slotsUsed / MAX_SLOTS_PER_REGION) * 100),
    };
  });

  const sites: SiteUtil[] = plan.sites.map((s) => ({
    key: s.key,
    name: s.name,
    region: s.region,
    subnetsAllocated: s.subnetCount,
    status: s.status,
  }));

  const findGaps = (
    resource: string,
    indices: number[],
  ): IndexGap => {
    const sorted = [...indices].sort((a, b) => a - b);
    const max = sorted.length > 0 ? sorted[sorted.length - 1] : -1;
    const gaps: number[] = [];
    for (let i = 0; i <= max; i++) {
      if (!sorted.includes(i)) gaps.push(i);
    }
    return {
      resource,
      usedIndices: sorted,
      gaps,
      nextFree: max + 1,
    };
  };

  const tunnelIndices = plan.tunnels.map((t) => {
    const prefix = t.prefix.split("/")[0];
    const parts = prefix.replace(/::/g, ":").split(":");
    const lastGroup = parts[parts.length - 1] || "0";
    return Math.floor(parseInt(lastGroup, 16) / 4);
  });

  const loopbackIndices = plan.loopbacks.map((lb) => {
    const parts = lb.address.split(":");
    const lastGroup = parts[parts.length - 1] || "0";
    return parseInt(lastGroup, 16);
  });

  return {
    generatedAt: plan.generatedAt,
    regions,
    sites,
    tunnelGaps: findGaps("tunnels", tunnelIndices),
    loopbackGaps: findGaps("loopbacks", loopbackIndices),
  };
}

function renderUtilMarkdown(util: UtilizationJson): string {
  const lines: string[] = [];
  lines.push("# Address Plan Utilization", "");
  lines.push(`Plan generated: ${util.generatedAt}`, "");

  lines.push("## Region Capacity (/44 slots per /40)", "");
  lines.push("| Region | Purpose | Status | Used | Total | Utilization |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (
    const r of util.regions.sort((a, b) => b.slotsUsed - a.slotsUsed)
  ) {
    const bar = r.pct > 0 ? `${"█".repeat(Math.ceil(r.pct / 10))}` : "░";
    lines.push(
      `| ${r.key} | ${r.purpose} | ${r.status} | ${r.slotsUsed} | ${r.slotsTotal} | ${bar} ${r.pct}% |`,
    );
  }
  lines.push("");

  lines.push("## Site Subnet Count", "");
  lines.push("| Site | Region | Subnets | Status |");
  lines.push("| --- | --- | --- | --- |");
  for (
    const s of util.sites.sort((a, b) =>
      b.subnetsAllocated - a.subnetsAllocated
    )
  ) {
    lines.push(
      `| ${s.name} | ${s.region} | ${s.subnetsAllocated} | ${s.status} |`,
    );
  }
  lines.push("");

  lines.push("## Index Pool Gaps", "");
  for (const pool of [util.tunnelGaps, util.loopbackGaps]) {
    lines.push(`### ${pool.resource}`, "");
    lines.push(`- Used indices: ${pool.usedIndices.join(", ") || "none"}`);
    lines.push(
      `- Gaps: ${pool.gaps.length > 0 ? pool.gaps.join(", ") : "none"}`,
    );
    lines.push(`- Next free index: ${pool.nextFree}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Utilization report definition. */
export const report = {
  name: "@shrug/ipam-utilization",
  description:
    "Address plan capacity: region slot usage, site subnet counts, tunnel/loopback index gaps.",
  scope: "model" as const,
  labels: ["ipv6", "ipam", "capacity"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const plan = await readLatestPlan(context);
    if (!plan) {
      return {
        markdown:
          "# Utilization\n\n_No plan data yet — run the `plan` method first._\n",
        json: { error: "no plan data" },
      };
    }

    const util = computeUtilization(plan);
    return {
      markdown: renderUtilMarkdown(util),
      json: util as unknown as Record<string, unknown>,
    };
  },
};
