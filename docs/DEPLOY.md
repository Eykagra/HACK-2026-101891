# Deployment

Target: one EC2 instance running Docker Compose behind Caddy.

## Why EC2 and not a serverless platform

Vercel was considered and rejected for a specific, technical reason: **SQLite
needs a persistent filesystem and a single writer.** A serverless function
cannot hold the `BEGIN IMMEDIATE` write lock across invocations, and its
filesystem is ephemeral, so every deploy would lose the board. Making it work
would mean a hosted Postgres — which changes the storage decision
([ADR 0001](adr/0001-sqlite-over-postgres.md)) for deployment convenience
rather than for a technical reason.

A `t3.micro` is sufficient. The scheduler is `O(V+E)`; the memory floor is Node
itself, around 60 MB.

## One-command provisioning

On a fresh Amazon Linux 2023 instance:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/submission/deploy/bootstrap-ec2.sh \
  | REPO_URL=https://github.com/<owner>/<repo>.git bash
```

The script installs Docker and the Compose plugin, clones the repository, pulls
secrets from SSM Parameter Store when available, builds, starts, and waits for
the health check. It is idempotent — re-running it deploys the latest commit.

## Security group

| Port | Source | Why |
| --- | --- | --- |
| 22 | your IP only | SSH. Never `0.0.0.0/0` |
| 80 | `0.0.0.0/0` | HTTP, and Caddy's ACME challenge |
| 443 | `0.0.0.0/0` | HTTPS |

Port 8080 is **not** exposed. The app container only publishes to the Compose
network; Caddy is the sole ingress.

## Secrets

API keys are never committed, never in the image, and never in shell history.

```bash
aws ssm put-parameter --name /taskflow/OPENAI_API_KEY --type SecureString --value 'sk-…'
aws ssm put-parameter --name /taskflow/GEMINI_API_KEY --type SecureString --value '…'
aws ssm put-parameter --name /taskflow/ADMIN_TOKEN   --type SecureString --value "$(openssl rand -hex 16)"
```

Attach an instance role with `ssm:GetParameter` and `kms:Decrypt` on
`/taskflow/*`. The bootstrap script reads them into `.env` (mode 600, gitignored)
at deploy time.

Without an instance role, edit `.env` on the box by hand. The app still runs
with no keys at all — suggestions come from the offline heuristic, and a value
still starting with `your-` is treated as absent so a half-filled `.env`
degrades safely rather than sending a placeholder to a vendor.

## HTTPS

With a domain pointed at the instance:

```bash
echo 'SITE_ADDRESS=taskflow.example.com' >> .env
docker compose up -d caddy
```

Caddy provisions a Let's Encrypt certificate on the first request. With no
domain it serves plain HTTP on port 80, which is the correct default for an
IP-only demo.

## Operating

```bash
docker compose ps
docker compose logs -f app          # one JSON object per line
docker compose restart app
docker compose up -d --build        # deploy a new commit
curl -s localhost/api/health | jq
```

Logs are structured JSON on stdout with a request id on every line, so
`docker logs` is greppable and CloudWatch can parse it without a shipper.
Nothing secret is ever logged.

## Backup

The whole database is one file on a named volume.

```bash
# Consistent snapshot, safe while the app is running (WAL-aware).
docker compose exec app sh -c \
  'sqlite3 /app/data/taskflow.db ".backup /app/data/backup.db"'
docker compose cp app:/app/data/backup.db ./taskflow-$(date +%F).db
```

Do **not** copy the `.db` file directly while the app is running — the WAL
sidecar means a plain `cp` can produce a torn snapshot.

Nightly via cron:

```cron
0 3 * * * cd /opt/taskflow-pro && docker compose exec -T app sh -c \
  'sqlite3 /app/data/taskflow.db ".backup /app/data/nightly.db"' \
  && aws s3 cp <(docker compose exec -T app cat /app/data/nightly.db) \
     s3://my-bucket/taskflow/$(date +\%F).db
```

## Rollback

```bash
git -C /opt/taskflow-pro checkout <previous-tag>
docker compose up -d --build
```

The schema uses `CREATE TABLE IF NOT EXISTS` and only ever adds columns, so
rolling the code back does not require rolling the data back.

## Restoring

```bash
docker compose down
docker compose run --rm -v "$PWD:/restore" app \
  cp /restore/taskflow-2026-09-27.db /app/data/taskflow.db
docker compose up -d
```

## Health and self-healing

`GET /api/health` returns status, uptime, the AI configuration and board
counts. Both the Dockerfile and Compose define a healthcheck against it;
`restart: unless-stopped` plus the healthcheck means a wedged process is
replaced without intervention.

`tini` as PID 1 forwards `SIGTERM`, which is what lets the graceful-shutdown
handler in `src/main.ts` actually run — finishing in-flight requests and
checkpointing the WAL before exit.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Container restarts in a loop | invalid config; the process refuses to start rather than serve 500s | `docker compose logs app` — the message names the variable |
| `SQLITE_CANTOPEN` | volume permissions | the image runs as `node`; ensure the volume is writable |
| Suggestions are noisy and a banner mentions the heuristic | no API keys resolved | check SSM and `.env`; a `your-…` value counts as absent |
| `403` on demo reset | `ADMIN_TOKEN` unset in production | set it; the route is disabled rather than open by default |
| Certificate not issued | DNS not pointing at the instance, or port 80 blocked | Caddy needs inbound 80 for the ACME challenge |
