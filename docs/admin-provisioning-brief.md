# xChief Gold Rush - what we need from administration

The game runs on managed cloud services; the developer deploys and wires everything from the dashboards and command line. From you we need three things: **access**, **one DNS record**, and **billing later**.

## 1. Give the developer access (member or owner) to

- **Supabase** organization
- **Vercel** team
- **Fly.io** organization
- **Elastic Mail** account (already in hand)
- **Finnhub** - an account with an API key (free tier is enough to start)

GitHub access is already in place. Nothing needs to be connected between platforms by you; the developer does the wiring.

## 2. DNS - one record

Email DNS (`goldrush.xchief.academy`) is already set up and verified. The only remaining DNS is the **campaign domain the public will land on**, pointed at Vercel. Once the developer adds the domain in Vercel, Vercel shows the exact record (a CNAME, or an A record for a root domain) - add it at the domain's DNS provider.

## 3. Billing - not yet

**Note: everything starts on free tiers. Paid plans are requested only after the application has been tested for at least one day (the day after launch), not before.** When that time comes, these are the plans and why, based on the projected load (50 players at once, up to 2,000 players a day, one month):


| Platform         | Plan          | Approx. cost  | Why the free tier is not enough                                                                                              |
| ---------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Vercel**       | Pro           | ~$20 / month  | Free "Hobby" is non-commercial only and its bandwidth cap (~100 GB) is below our ~180 GB / month.                            |
| **Supabase**     | Pro           | ~$25 / month  | Free tier pauses idle projects and caps function calls at ~500k / month; we expect ~1.5-2M. Pro adds backups and no pausing. |
| **Fly.io**       | Pay-as-you-go | ~$3-5 / month | Requires a card on file to run the price relay at all.                                                                       |
| **Elastic Mail** | Sending plan  | ~$29 / month  | Free tier is ~100 emails / day; login codes need up to ~2,000 / day. Confirm the current plan covers this.                   |
| **Finnhub**      | Free          | $0            | One shared connection; upgrade only if the real-time gold feed turns out to be gated.                                        |
| **GitHub**       | Free          | $0            | -                                                                                                                            |


**Total once upgraded: roughly $75-80 / month.** Prices are approximate; payment is a business decision based on the expected traffic.

