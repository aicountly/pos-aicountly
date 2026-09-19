# Deploying POS

## Layout

```
web/          React app (Vite). Builds to web/dist.
server-php/   PHP API. Plain PHP, no build step — deployed as-is.
docs/         this file, plus the auth notes
```

## What lands where on cPanel

| Workflow | Deploys | Destination | Reachable at |
| --- | --- | --- | --- |
| Deploy to cPanel Production | `web/dist/` then `server-php/` | `<remote root>/` and `<remote root>/api/` | https://pos.aicountly.com (+ `/api`) |
| Deploy to cPanel Sandbox | `web/dist/` then `server-php/` | `<remote root>/` and `<remote root>/api/` | https://pos.gh.aicountly.com (+ `/api`) |

`<remote root>` is the `*_SSH_REMOTE_ROOT` secret for that environment,
normally `public_html` (or the subdomain's own document root).

Deployment is manual only — **Actions → pick a workflow → Run workflow**.
Nothing deploys on push or merge.

## One workflow per environment, not per half

Production and sandbox are genuinely separate targets — different SSH
credentials, different servers — so each gets its own workflow. Within one
environment, though, the web build and the API are deployed by the same run,
one after the other: first `web/dist/` to the document root, then
`server-php/` to `api/` inside it. Splitting those into separate workflows
would only mean clicking twice for something that is always meant to happen
together, with two SSH sessions and two sets of runner setup instead of one.

### Why the api folder survives the web deploy step

The web deploy step runs `rsync --delete` against the document root, which
would otherwise remove everything not in the build — including `api/`, since
the API lives inside the document root. That step therefore excludes `api/`
explicitly. **Removing that exclude would delete the entire backend on the
next deploy.**

### Why the API's .env survives the API deploy step

The API deploy step also runs `rsync --delete`, this time against `api/`. The
API's `.env` is created once by hand on the server and exists nowhere else, so
both `--exclude='.env'` and `--exclude='.env.*'` are what keep it alive.
Removing them would wipe the live configuration on the next deploy.

Neither `.env` is ever uploaded either: `.gitignore` keeps them out of the
repository, and the workflow fails the build outright if a committed `.env`
appears under `server-php/`.

## Configuration: two different mechanisms

This is the part worth reading carefully, because the frontend and the backend
behave in opposite ways.

### React (web/) — build time

Vite inlines every `VITE_*` value into the JavaScript bundle when the app is
compiled. The deployed result is plain static files that **never read a `.env`
from disk**. Putting a `.env` in the document root has no effect.

To change a frontend value: change it in the workflow (or in the optional
repository variable), then re-run the workflow. The rebuild is what applies it.

Never put a secret in a `VITE_` variable — anything inlined into the bundle is
public to anyone who views the page source.

The API URL needs no configuration in the normal case: with
`PROD_API_BASE_URL` / `SANDBOX_API_BASE_URL` unset, the app calls its own origin
+ `/api`, which is where the same workflow's API step deploys `server-php`.
Those repository variables exist only to override that — for example if the API
moves to its own domain.

### server-php — runtime

PHP reads its `.env` on **every request**. So the API's `.env` belongs on the
server, and only on the server.

Create it once by hand — cPanel File Manager or SSH — at
`<remote root>/api/.env`, from `server-php/.env.example`:

```
APP_ENV=production
```

That is the whole file for a production deploy; `APP_ENV=sandbox` for the
sandbox. `GET /api/health` reports the value back, which is how you confirm
you are looking at the environment you think you are.

A real deployment also needs the database section, because every endpoint that
reads a row answers 503 without it:

```
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=<cpaneluser>_pos
DB_USER=<cpaneluser>_pos
DB_PASS=<the password>
```

cPanel prefixes both database and user with the account name, so a database
created as `pos` is really `<cpaneluser>_pos`. Use the full prefixed names, add
the user to the database with **ALL PRIVILEGES**, and keep `DB_HOST` as
`127.0.0.1` or `localhost` — on cPanel the database is on the same machine, and
the public hostname will not accept a connection from it.

The file has to be readable by the user Apache runs PHP as (`chmod 640` owned by
the cPanel account is right). A key with an empty value counts as missing.

### Protecting the API's .env over HTTP

Because `api/` sits inside the document root, `.env` would be fetchable at
`https://pos.aicountly.com/api/.env` unless Apache is told otherwise.
`server-php/.htaccess` ships the rule that denies it:

```apache
RedirectMatch 404 /\.(?!well-known)
```

The web build does the same for the document root via `web/public/.htaccess`,
but those rules stop applying inside `api/` once the API's own take over.

### The Authorization header

`server-php/.htaccess` also copies the `Authorization` header into the request
environment. Apache does not pass it to PHP under CGI/FastCGI unless told to,
and without it the auth relay forwards no credential — the portal answers 401
and sign-in fails for everyone, with nothing in the logs to explain why.

## Required secrets

Per environment, under Settings → Secrets and variables → Actions → Secrets:

`PROD_SSH_HOST`, `PROD_SSH_PORT`, `PROD_SSH_USER`, `PROD_SSH_PRIVATE_KEY`,
`PROD_SSH_REMOTE_ROOT` — and the same five with a `SANDBOX_` prefix.

Both workflows validate these before building, and verify SSH authentication
before writing anything to the server. Because the deploys run with
`--delete`, a `*_SSH_REMOTE_ROOT` that would resolve to the home directory
itself, a system directory, or anything containing `..` is refused.

## First deploy checklist

1. Create the subdomain in cPanel and note its document root.
2. Add the five SSH secrets for that environment.
3. Run **Deploy to cPanel …**. This deploys web and API together; the API is
   deployed but unconfigured until the next step.
4. Create `api/.env` on the server (see above), from `server-php/.env.example`.
5. Re-run **Deploy to cPanel …** (or just confirm the API), then confirm
   `https://<host>/api/health` returns the right `env` and open the site to
   sign in. See [auth/AICOUNTLY_AUTH_WORKFLOW.md](auth/AICOUNTLY_AUTH_WORKFLOW.md)
   for what a healthy login looks like.

## When the app says it cannot reach the database

The banner on the screen names the cause, and `GET /api/health` and
`php bin/doctor.php` say the same thing in more detail. Start with whichever is
in front of you.

### From anywhere: the health endpoint

```bash
curl -s https://pos.aicountly.com/api/health
```

It is unauthenticated, so this works from a laptop. Read three fields:

| Field | What it means |
| --- | --- |
| `usable` | `false` means the site is up and the product cannot be used |
| `database.reason` | which of the causes below it is |
| `advice` | the one thing to do about it |

`database.config` is the part no other check can see, because it describes the
PHP that serves the **website**:

* `driver: false` — that PHP has no `pdo_pgsql`. This is the one failure that
  survives a perfectly good deploy, because cPanel configures the web PHP and
  the SSH PHP separately: migrations run fine over SSH and every page still
  fails. Fix it in **Select PHP Version → Extensions**, ticking `pdo_pgsql`
  **and** `pgsql` for the domain.
* `env_file: false` — there is no readable `api/.env` on the server.
* `configured: false` — the file is there but `DB_NAME` or `DB_USER` is empty.

Nothing in that response ever names the database, the role or the host: it is a
public endpoint, and those names are exactly what PostgreSQL's own error text
hands out. They are in the error log instead, under the `ref=` in the banner.

### On the server: the doctor

Over SSH, or cPanel's **Terminal**:

```bash
cd ~/public_html/api                 # or the subdomain's own document root
php bin/doctor.php
```

It checks the same things the app does, in the same order — PHP, driver, `.env`,
TCP, login, schema, privileges — and stops at the first one that is actually
broken, printing the driver's full message and what to do about it. Exit code 0
means the app can use its database.

The PHP on `PATH` is usually the oldest one installed, and this API needs 8.1+
with `pdo_pgsql`. To see what the account has:

```bash
for p in /opt/cpanel/ea-php*/root/usr/bin/php; do
  printf '%s  %s  pdo_pgsql:%s\n' "$p" "$("$p" -r 'echo PHP_VERSION;')" "$("$p" -m | grep -c '^pdo_pgsql$')"
done
```

Then run the doctor with one that says `pdo_pgsql:1`, e.g.
`/opt/cpanel/ea-php84/root/usr/bin/php bin/doctor.php`.

### The causes, and what each one needs

| `reason` | What happened | What fixes it |
| --- | --- | --- |
| `not_configured` | `DB_NAME` or `DB_USER` is missing from `api/.env` | fill them in, with the cPanel account prefix |
| `driver_missing` | this PHP has no `pdo_pgsql` | Select PHP Version → Extensions |
| `unreachable` | nothing answered on `DB_HOST:DB_PORT` | start PostgreSQL; use `127.0.0.1`, not the public hostname |
| `refused` | the role or password was rejected | re-enter `DB_USER`/`DB_PASS`; add the user to the database with ALL PRIVILEGES |
| `no_such_database` | `DB_NAME` names a database that is not there | use the prefixed name, `<cpaneluser>_pos` |
| `schema_missing` | it connected, and the tables do not exist | `php bin/migrate.php` |
| `schema_stale` | the database is a release behind the code | `php bin/migrate.php` |
| `permission_denied` | it connected, and the role cannot read the tables | grant the role access to the existing tables |

Only `unreachable`, `overloaded` and `starting_up` are worth retrying. The rest
need a change, which is why the app no longer offers Retry for them.

### Applying the schema by hand

The deploy runs migrations on every deploy and fails if they fail, so this is
only needed on a host that was set up outside the workflow:

```bash
cd ~/public_html/api
php bin/migrate.php --status     # list what would run, change nothing
php bin/migrate.php              # apply it
```

Each file runs in its own transaction and is recorded by name and checksum, so
running it twice is a no-op and a half-applied migration cannot exist.

### Reading the log

Every database failure is logged with a reference, and the banner on the screen
shows the same one:

```bash
grep 'ref=A1B2C3' ~/logs/*.log ~/public_html/api/error_log 2>/dev/null
grep '\[pos\] db' ~/logs/*.log 2>/dev/null | tail -20
```

cPanel writes PHP errors either to the per-domain log under `~/logs/` or to an
`error_log` file beside the script, depending on the host's configuration.

### What is not fetchable over HTTP

`api/` sits inside the document root, so everything in it would otherwise be
served as a file. `server-php/.htaccess` denies `bin/`, `database/`, `src/` and
`tests/`, and `bin/migrate.php` and `bin/doctor.php` refuse to run under
anything but the CLI as well — without that, `api/database/migrations/*.sql`
would publish the schema and `api/bin/migrate.php` would let a stranger run
migrations and read the database, role and host names out of the error.
