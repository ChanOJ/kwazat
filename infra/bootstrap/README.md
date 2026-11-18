# Bootstrap (phase 1)

One-off steps done by hand, because OpenTofu needs them before it can run: a project and a
bucket to hold its state, an API key, and the state passphrase. Everything else is created by
the stacks (see [docs/infrastructure.md](../../docs/infrastructure.md)).

Region: Paris (`fr-par`) everywhere.

## 1. Verify the organisation's identity

Unverified organisations may get lower quotas.

1. Scaleway console > organisation menu (top left) > **Settings**.
2. **Verify identity**, and follow the steps.

## 2. Create the `kwazat-shared` project

1. Organisation menu > **Projects** > **Create Project**.
2. Name: `kwazat-shared`.
3. Description: `Kwazat shared resources: OpenTofu state, image registry, DNS zones.`

`kwazat-staging` and `kwazat-prod` are **not** created by hand: `infra/shared` creates them.

## 3. Create the state bucket

1. Switch to the `kwazat-shared` project (project menu, top bar).
2. **Object Storage** > **Create bucket**.
3. Name: `kwazat-tofu-state` · Region: **Paris** · Visibility: **Private**.
   If the name is taken, pick another one and tell Claude: it is set in
   `infra/shared/versions.tf`.
4. Open the bucket > **Bucket settings** > **Versioning**: **Enable**. Old versions of the state
   are then kept, so a bad write can be rolled back.

## 4. Create the operator API key

This key is used from your laptop only. CI gets its own keys, limited to one project each
(phase 3).

1. Organisation menu > **IAM** > **API keys** > **Generate API key**.
2. Bearer: **Myself (IAM user)**.
3. Description: `kwazat-operator (OpenTofu from laptop)`.
4. Expiration: **1 year**.
5. "Will this API key be used for Object Storage?": **Yes**, preferred project
   **`kwazat-shared`**.
6. In Proton Pass, vault **Kwazat**, create two **Password** items:
   - `scaleway-operator-access-key`: the access key (starts with `SCW`);
   - `scaleway-operator-secret-key`: the secret key (shown only once).

## 5. Store the organisation ID

1. Organisation menu > **Settings**: copy the **Organization ID**.
2. Proton Pass, vault **Kwazat**, new **Password** item `scaleway-organization-id`, with the ID as
   the password.

It is not a secret, but the repository is treated as public, so it stays out of it.

## 6. Create the state passphrase

1. Proton Pass, vault **Kwazat**, new **Password** item `tofu-state-passphrase`.
2. Generate a random password of **at least 32 characters**.

Losing it means losing access to the state: Proton Pass is its only copy, together with the
GitHub secret created in phase 3.

## 7. First run

From the repository root (`pass-cli` logged in):

```bash
pnpm infra shared init
```

```bash
pnpm infra shared plan -out=shared.tfplan
```

The plan should create exactly three resources: the `kwazat-staging` and `kwazat-prod` projects
and the `kwazat` registry namespace. Show it to Claude, then:

```bash
pnpm infra shared apply shared.tfplan
```

## 8. Check the state lock

Run two plans at the same time in two terminals: the second one must stop with a lock error.
This confirms that Scaleway honours the conditional writes OpenTofu uses for locking.

```bash
pnpm infra shared plan
```
