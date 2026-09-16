# Gold Rush - what we need from administration

Three items: a server, a DNS record, and read access to the code repository. About one hour of work.

## 1. The server

| Item | Requirement |
|---|---|
| Provider | Any VPS provider with snapshots (Hetzner, DigitalOcean, Vultr, OVH, Linode) |
| Size | 4 vCPU, 8 GB RAM, 80 GB SSD |
| OS | Ubuntu 24.04 LTS, fresh install |
| Region | Frankfurt or Amsterdam |
| Snapshots | Enabled |
| Access | Root SSH with the developer's public key (they will send it); password login off |
| Network | One public IPv4 address; no provider-side firewall rules needed |

Hand over: the IP address and confirmation that the SSH key is installed.

## 2. Cloudflare and DNS

The domain is `xchief.academy`. The game runs at `goldrush.xchief.academy`.

| Item | Requirement |
|---|---|
| Zone | `xchief.academy` in a Cloudflare zone (free plan is enough) |
| DNS record | `A` record `goldrush` -> the server's IPv4, proxy status Proxied (orange cloud) |
| SSL/TLS mode | Full (strict) |
| Bot Fight Mode | On |
| Developer access | Add the developer as a member of the zone (DNS role or Administrator). They will add one Access rule for the operator pages and one rate-limit rule themselves |

Hand over: confirmation of the record, and member access for the developer.

## 3. Code repository access

The server pulls the code from `github.com/AIT-ERP/xChief-Gold-Rush` over SSH. This needs a deploy key on that repository.

A deploy key belongs to the repository, not to a person. Only someone with admin rights on the repository can add one. Do one of these:

- Add the server's public SSH key as a read-only deploy key on the repository (Settings, Deploy keys). The developer sends the key.
- Or give the developer admin rights on the repository, and they add it themselves.

Hand over: confirmation that the deploy key is installed, or the repository admin role.

## 4. Monthly cost

| Item | Monthly |
|---|---|
| VPS 4 vCPU / 8 GB with snapshots | ~$25-40 |
| Cloudflare free plan | $0 |
| Total | ~$25-40, fixed |
