# Security Setup — TechParts POS

Offline POS for a phone repair counter. The threat model is staff skimming
and record tampering; these steps harden a Windows workstation so the
controls in this build (elevation gates, shift blind count, hash-chained
audit log) actually hold.

## 1. Two Windows accounts

- **Cashier account** — Standard user (not Administrator) for daily use.
  Settings → Accounts → Family & other users → Add account (local).
- **Manager account** — Administrator. Only the owner knows its password.

## 2. Auto-start under the Manager account

Schedule the POS to start with the machine, running as Manager:

```
schtasks /create /tn "TechPartsPOS" /tr "\"C:\TechPartsPOS\TechPartsPOS.exe\"" /sc onlogon /ru ManagerAccount /rl highest
```

(Replace the path and account name.) The cashier session reaches the app at
`http://localhost:3000` — the server binds to loopback only, so the database
never listens on the network.

## 3. NTFS isolation of the data folder

Deny the cashier account write access to the database directory
(`...\data\shop.db`); grant it only read on `public\` if needed. With the
server running as Manager, the cashier browser talks only to the HTTP API —
it cannot open or edit the DB file directly.

## 4. Manager PIN

- Change the factory PIN (`1234`) on first boot — the app forces this.
- Keep the PIN secret; it gates inventory edits, stock adjustments, voids,
  exports, dashboard, and audit access with a 15-minute elevation window.

## 5. Daily checks for the owner

1. **Close the shift blind** (rail → Close shift): count the drawer first,
   enter the count, and only then see expected vs variance. Variances over
   ₱50 land on the Exceptions panel.
2. **Exceptions panel** (Reports tab): voided sales, cash refunds, discounts
   ≥5%, and shift variances in one list. Every void carries the manager's
   audit attribution and restores stock net of any RMA'd units.
3. **Audit chain**: the audit log is append-only and each row is chained
   with SHA-256 to its predecessor. Run `GET /api/audit/verify`
   (manager-elevated) — `ok:false` with `first_bad_id` means the log was
   edited out-of-band. Trigger-protected: even `UPDATE`/`DELETE` via SQL
   is rejected while the app is running.

## 6. Backups

The app keeps daily rolling backups (14 days) in `backups\`. Copy the folder
off the machine weekly.
