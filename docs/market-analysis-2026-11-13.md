# Market Analysis: TechParts POS vs the field (2026-11-13)

Desk research only: public pricing pages and 2026 comparison guides, linked per claim.
Nothing here was measured in production, and no pricing below was changed.

## 1. The competitive field

| Product | Entry price | Model | Repair features | Notes |
|---|---|---|---|---|
| [RepairDesk](https://www.repairdesk.co/pricing) | $99/store/mo ($79 annual) | SaaS, per store | Purpose-built: tickets, [status SMS](https://www.repairdesk.co/repairdesk-sms), parts, invoices | Growth tier $149/mo; 5 users included |
| [RepairShopr](https://spotspos.com/guides/best-repair-shop-software) | $69.99/mo ($59.99 annual) | SaaS | Tickets, invoices, CRM | Starter caps 75 tickets + invoices/month; Repair tier $139.99/mo |
| [Orderry](https://spotspos.com/guides/best-repair-shop-software) | $39/mo (100 work orders) | SaaS | Work orders, inventory, mobile tools | 7-day trial; cheapest credible repair entry |
| [Loyverse](https://loyverse.com/en-us) | Free | SaaS, paid add-ons | None (retail only) | [Offline-capable](https://digablopos.com/en/blog/best-free-pos-small-business-2026), free analytics limited to 31 days |
| [Square](https://squareup.com/us/en/point-of-sale) | Free | SaaS, payment spread | None (retail only) | Payments-led; advanced reporting needs paid tiers |

Two clusters: repair-specific SaaS at $39-149 per store per month, and free/cheap
general retail POS with no repair features.

## 2. Where TechParts POS sits

One-time licensed Windows executable, local SQLite, no runtime dependencies,
optional cloud mirror ([repairsync](https://repairsync.bot-keep.xyz/)) for the
owner's phone. No per-month server cost to the shop, no dependency on our
infrastructure to ring up a sale.

Differences that matter to a small shop, each already shipped:

- **Offline-first.** The counter keeps selling with no internet; Loyverse is the
  only competitor above that matches this, and it has no repair features.
- **Repair + retail in one binary.** Business profiles (`business_type`) hide
  repair workflows for general retail; competitors force a choice of cluster.
- **Utang (FIFO credit) built in.** Dual-tier pricing, oldest-debt-first
  allocation, per-customer ledgers. General POS treats this as an add-on;
  repair SaaS mostly ignores informal credit.
- **Hardware-agnostic printing.** Raw ESC/POS at 58mm and 80mm with browser
  fallback; no proprietary printer lock-in.

Honest gaps versus the repair SaaS cluster (as of this tree):

- **No customer SMS/status notifications.** RepairDesk and peers sell this. We
  cannot send SMS without a paid provider and a shop-side account; the claim
  stays out of marketing until one exists.
- **No purchase orders.** We have a supplier reorder sheet; RepairShopr-class
  tools have full POs with receiving.
- **No technician commissions.** Status tracking and assignment exist; pay
  computation does not.
- **Single shop per install.** The mirror is per-shop; multi-location needs one
  install per branch plus separate mirrors.

## 3. What this means for the roadmap

Ranked by value-to-effort, with the ponytail rule applied (smallest version
that answers a real demand):

1. **Reorder-to-receiving.** Convert the existing reorder sheet into received
   stock (one action per supplier line, quantity + cost editable). Closes the
   PO gap at maybe a tenth of a PO system's size.
2. **Low-stock awareness at the counter.** The reorder list exists but lives on
   the manager tab; a badge on the inventory rail entry (count already
   computed) makes it visible without any new backend.
3. **Ticket status without SMS.** The claim stub and RMA flow already print;
   a printable "ready for pickup" slip is the no-provider version of the SMS
   workflow. Real SMS stays parked until a shop asks and pays for it.
4. **Not now: multi-branch, commissions.** No evidence in the tree of demand;
   YAGNI.

## 4. Pricing posture (owner decision, not changed here)

The repair SaaS cluster prices $39-149 per store per month ($468-1,788/store
per year). A one-time license undercutting even one year of Orderry's entry
tier is a defensible anchor; a support-or-updates subscription is the common
way to keep that revenue recurring without becoming a SaaS dependency. No
pricing pages, store listings, or license terms were modified for this
analysis.

## Sources

- [RepairDesk pricing](https://www.repairdesk.co/pricing)
- [SpotsPos best repair shop software 2026](https://spotspos.com/guides/best-repair-shop-software)
- [TechsBox repair shop software pricing comparison](https://techsbox.com/blog/repair-shop-software-pricing-comparison)
- [RepairDesk SMS](https://www.repairdesk.co/repairdesk-sms)
- [Loyverse](https://loyverse.com/en-us)
- [Free POS for small business 2026](https://digablopos.com/en/blog/best-free-pos-small-business-2026)
- [Square POS](https://squareup.com/us/en/point-of-sale)
- [Square free POS software](https://squareup.com/us/en/the-bottom-line/operating-your-business/free-pos-software)
- [Orderry: top features 2026](https://orderry.com/blog/top-10-features-to-look-for-in-a-repair-shop-management-software-in-2026-10082)
