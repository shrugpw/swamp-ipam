/**
 * Model-scope report for `@shrug/ipam`.
 *
 * Reads the latest `plan` resource and renders it as a formatted markdown
 * document with region/site/subnet/tunnel/loopback/anycast tables. The
 * rendering logic lives in the model module so report and model share one
 * source of truth.
 *
 * @module
 */
import {
  readLatestPlan,
  renderMarkdown,
  renderTopologyMermaid,
  type ReportContext,
} from "../models/ipam.ts";

/** Report definition. */
export const report = {
  name: "@shrug/ipam-report",
  description:
    "Render the IPv6 address plan as markdown tables (regions, sites, subnets, tunnels, loopbacks, anycast VIPs).",
  scope: "model" as const,
  labels: ["ipv6", "ipam", "networking"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const plan = await readLatestPlan(context);
    if (!plan) {
      return {
        markdown:
          "# IPv6 Address Plan\n\n_No plan data yet — run the `plan` method first._\n",
        json: { error: "no plan data" },
      };
    }

    const markdown = renderMarkdown(plan);
    const json: Record<string, unknown> = {
      root: plan.root,
      rootLength: plan.rootLength,
      generatedAt: plan.generatedAt,
      counts: plan.counts,
      validationErrors: plan.validationErrors,
      blocks: plan.blocks,
      sites: plan.sites,
      subnets: plan.subnets,
      tunnels: plan.tunnels,
      loopbacks: plan.loopbacks,
      anycastVips: plan.anycastVips,
      topologyMermaid: renderTopologyMermaid(plan),
    };
    return { markdown, json };
  },
};
