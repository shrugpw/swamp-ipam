# @shrug/ipam

IPv6 address planner for region-rooted /40 allocation schemes.

Pure-compute model — no external API calls. Takes a hierarchical allocation
definition (regions, sites, subnets, tunnels, loopbacks, anycast VIPs) as
runtime input, computes fully-qualified IPv6 prefixes, validates invariants
(no overlaps, referential integrity, no duplicate nibbles), and writes
structured resource data consumable by other models via CEL expressions.

The model is fully generic — supply your own allocation plan via `--input-file`
without forking the extension. See `examples/example-plan.yaml` for a complete
reference plan using RFC 9637 documentation space.

## Quick start

```bash
# Create a model instance
swamp model create @shrug/ipam my-ipam

# Run the plan method with your allocation file
swamp model method run my-ipam plan --input-file plans/my-plan.yaml

# View the rendered report
swamp report run my-ipam
```

## Plan file structure

The input file defines the full allocation hierarchy:

```yaml
root: "3fff:0db8"
rootLength: 36
infraRegion: infra
infraSlot: "0e"
loopbackSuffix: ffff

regions:
  infra:
    nibble: "0"
    purpose: Infrastructure
    status: active
  na:
    nibble: "b"
    purpose: NA
    status: active

sites:
  dc1:
    region: na
    slotNibble: "1"
    name: DC1
    location: "Ashburn, VA"
    provider: Example Cloud
    status: planned

subnets:
  dc1-lan:
    site: dc1
    vlan: 10
    nibbles: "0010"
    purpose: LAN
    status: planned

tunnels:
  hub-dc1:
    endpointA: Hub
    endpointB: DC1
    index: 0
    purpose: Backbone
    status: planned

loopbacks:
  hub:
    node: Hub
    index: 1
    role: Route reflector
    status: planned

anycastPrefixes:
  global:
    region: infra
    nibbles: "ce"
    purpose: Global anycast
    status: planned

anycastVips:
  dns:
    prefix48: global
    hostPart: "1"
    service: DNS
    status: planned
```

## Computed outputs

The `plan` method produces:

- **Regional blocks** — /40 prefixes per region
- **Site envelopes** — /44 stride with initial /48 allocation
- **Subnets** — /64 assignments within sites
- **Tunnels** — /126 P2P links from the infra /48
- **Loopbacks** — /128 router IDs from the infra loopback /64
- **Anycast VIPs** — /128 service addresses in anycast /48 blocks

All outputs include fully-qualified, compressed IPv6 prefixes and validation
error reporting for overlaps and referential integrity.

## Cross-model consumption

Other models can read the plan via CEL:

```cel
data.latest("my-ipam", "plan").attributes.sites
data.latest("my-ipam", "plan").attributes.tunnels
```

## Model type

`@shrug/ipam`

## Methods

| Method | Description |
| --- | --- |
| `plan` | Compute the full address plan and validate invariants |

## Resources

| Spec | Description |
| --- | --- |
| `plan` | Complete plan with blocks, sites, subnets, tunnels, loopbacks, anycast VIPs |

## Reports

| Report | Description |
| --- | --- |
| `@shrug/ipam-report` | Markdown tables matching network plan doc format |
