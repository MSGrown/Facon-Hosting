# FACON HOST Security Specification

## 1. Data Invariants
1. **Identity Integrity**: A `UserProfile` document at `/users/{userId}` can only be created by the verified authenticated user matching `userId`, and must always initialize with `role: "user"`, `plan: "FREE"`, and `suspended: false`.
2. **Privilege Isolation**: Regular users cannot modify their own `role`, `plan`, `suspended`, or `serverLimit` fields, nor write to `/admins/{adminUid}`. Only verified admins (bootstrapped admin email or `/admins` entry) can grant admin rights or suspend accounts/servers.
3. **Free Plan Immutability**: Every `BotServer` at `/servers/{serverId}` is strictly bound to `plan: "FREE"`, `ramLimitMb: 2048`, `cpuLimitPct: 200`, `diskLimitMb: 8192`, `bandwidthMbps: 150`, and `backupLimit: 2`.
4. **Master Gate Subcollections**: Subcollections `/files`, `/envVars`, `/backups`, and `/logs` under `/servers/{serverId}` verify parent server ownership via `get(/databases/$(database)/documents/servers/$(serverId))`. If the parent server is `suspended`, owner writes to subcollections are blocked.
5. **PII Isolation**: User documents containing `email` and server documents containing `ownerEmail` are strictly readable only by the owning user (`ownerId == request.auth.uid`) or verified admins (`isAdmin()`).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Self-Admin Registration**: Creating `/users/attackerUid` with `role: "admin"` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoofing**: Request with `token.email == "sadhikmohammad292@gmail.com"` and `email_verified: false` -> `PERMISSION_DENIED`.
3. **User PII Blanket Read**: Non-admin user calling `get` or `list` on `/users/victimUid` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection on Server**: Creating `/servers/srv1` with extra field `isUnlimited: true` -> `PERMISSION_DENIED`.
5. **Resource Quota Tampering**: Creating or updating `/servers/srv1` with `ramLimitMb: 16384` or `plan: "ENTERPRISE"` -> `PERMISSION_DENIED`.
6. **Owner Spoofing**: User A creating `/servers/srv1` with `ownerId: "userB"` -> `PERMISSION_DENIED`.
7. **Suspended Server Bypass**: Owner attempting to change `status` from `"suspended"` back to `"running"` -> `PERMISSION_DENIED`.
8. **Timestamp Forgery**: Creating a server with client-backdated `createdAt` (`!= request.time`) -> `PERMISSION_DENIED`.
9. **ID Poisoning**: Creating a document with a 300-character ID or invalid characters (`../admin`) -> `PERMISSION_DENIED`.
10. **Subcollection Orphan/Unauthorized Access**: User A attempting to read or write `/servers/userB_server/envVars/token` -> `PERMISSION_DENIED`.
11. **Value Poisoning on Update**: Updating `startupCommand` with a 10,000-character string or boolean -> `PERMISSION_DENIED`.
12. **Server List Scraping**: Non-admin issuing an unfiltered `list` query on `/servers` -> `PERMISSION_DENIED` (enforced via `resource.data.ownerId == request.auth.uid`).
