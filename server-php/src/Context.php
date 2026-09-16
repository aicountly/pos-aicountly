<?php

declare(strict_types=1);

namespace Aicountly\Api;

use Aicountly\Api\Clients\ManageClient;

/**
 * The company / branch / financial year every scoped request carries.
 *
 * Three ids and nothing else. The names and dates behind them belong to Manage
 * and are read from Manage at the point of use.
 *
 * TENANT ISOLATION: `cmp_id` arriving in a query string is a claim, not a fact.
 * assertAllowed() checks it against what Manage says this session may open, and
 * a company the session has no access to is a 403 — never a query that simply
 * returns nothing, which would leak the difference between "no rows" and "not
 * yours" and would break the moment a query forgot its WHERE clause.
 */
final class Context
{
    /** @var array<string, bool> */
    private static array $verified = [];

    /**
     * What Manage said this session is on this company, per verified key.
     *
     * Kept beside $verified rather than inside it because the memo has to keep
     * working for the SECOND caller too: assertAllowed() returns early on a
     * memo hit, and without this the promotion would happen once and then
     * silently stop for every later Auth object in the same request.
     *
     * @var array<string, int|null>
     */
    private static array $accessTypes = [];

    private function __construct(
        public readonly int $cmpId,
        public readonly int $fyId,
        /** 0 = consolidated, all branches. */
        public readonly int $boId,
    ) {
    }

    /** Read the scope out of the request, refusing anything incomplete. */
    public static function fromRequest(): self
    {
        $cmpId = Http::intParam('cmp_id', 0) ?? 0;
        $fyId  = Http::intParam('fy_id', 0) ?? 0;
        $boId  = Http::intParam('bo_id', 0) ?? 0;

        if ($cmpId <= 0 || $fyId <= 0) {
            Http::error(400, 'context_required', 'Pick a company and financial year first (cmp_id and fy_id are required).');
        }

        return new self($cmpId, $fyId, max(0, $boId));
    }

    /**
     * Confirm this session may open this company, per Manage.
     *
     * Memoised per request because it runs on every scoped endpoint; a failure to
     * reach Manage is a 503 and not an allow, because the alternative is serving
     * one tenant's data to another whenever Manage has a bad minute.
     */
    public function assertAllowed(Auth $auth): void
    {
        if ($auth->isService()) {
            // A service key is issued to a product, not to a person, and the
            // owning product has already checked the human behind it. What it
            // must still not do is act on a company outside the key's scope,
            // which ServiceKeyAuthenticator enforces when the key is resolved.
            return;
        }

        $key = $this->cmpId . ':' . $auth->fingerprint();
        if (isset(self::$verified[$key])) {
            if ($auth->promoteAccessType(self::$accessTypes[$key] ?? null)) {
                Permissions::forget($this, $auth);
            }

            return;
        }

        $result = (new ManageClient())->withSession($auth->sesKey())->companyInfo($this->cmpId);

        if (!$result['ok']) {
            // Unreachable is not "allowed". A tenant check that fails open is not
            // a tenant check.
            Http::error(503, 'context_unavailable', 'Cannot confirm company access right now. Please retry.');
        }

        $body = $result['body'] ?? [];
        $company = $body['data'] ?? $body['company'] ?? $body;
        $resolved = (int) ($company['cmp_id'] ?? $company['comp_id'] ?? $company['id'] ?? 0);

        if ($resolved !== $this->cmpId) {
            Http::forbidden('You do not have access to this company.');
        }

        self::$verified[$key] = true;

        // The company row is already in hand, so learning whether this person
        // owns the company costs nothing extra. Doing it here rather than in a
        // separate lookup is the whole point: this check already runs on every
        // scoped endpoint, and a second call to Manage for the same row would
        // put it in the hot path of every screen twice.
        self::$accessTypes[$key] = self::resolveAcsType($company);
        if ($auth->promoteAccessType(self::$accessTypes[$key])) {
            Permissions::forget($this, $auth);
        }
    }

    /**
     * Read the company-access type out of a Manage company row.
     *
     * Mirrors `web/src/company/manageShapes.ts` exactly — explicit `acs_type`
     * wins, then the `ownership` label, then `is_creator` — because the browser
     * and the API disagreeing about who owns a company is a bug nobody would
     * find quickly. Manage has answered in several shapes over the years and
     * this has to read all of them.
     *
     * @param array<string, mixed> $company
     */
    private static function resolveAcsType(array $company): ?int
    {
        $raw = $company['acs_type'] ?? null;
        if (is_numeric($raw)) {
            $acs = (int) $raw;
            if ($acs === 0 || $acs === 1) {
                return $acs;
            }
        }

        $ownership = strtolower(trim((string) ($company['ownership'] ?? '')));
        if ($ownership === 'owner') {
            return 1;
        }
        if (in_array($ownership, ['shared', 'delegated', 'user', 'viewer', 'editor', 'member'], true)) {
            return 0;
        }

        $creator = $company['is_creator'] ?? null;
        if ($creator === true || $creator === 1 || $creator === '1' || $creator === 'true' || $creator === 'yes') {
            return 1;
        }

        return null;
    }

    /** @return array{cmp_id:int, fy_id:int, bo_id:int} */
    public function asQuery(): array
    {
        return ['cmp_id' => $this->cmpId, 'fy_id' => $this->fyId, 'bo_id' => $this->boId];
    }

    /** @return array{cmp_id:int, fy_id:int, bo_id:int} */
    public function asBody(): array
    {
        return $this->asQuery();
    }

    /**
     * The WHERE fragment and bindings every query in this product starts with.
     *
     * `bo_id` 0 means consolidated, so it narrows only when it is set — a branch
     * user sees their branch, a company user sees everything.
     *
     * @return array{0:string, 1:array<string, mixed>}
     */
    public function scopeClause(string $alias = ''): array
    {
        $prefix = $alias === '' ? '' : $alias . '.';
        $sql = $prefix . 'cmp_id = :ctx_cmp_id AND ' . $prefix . 'fy_id = :ctx_fy_id';
        $params = ['ctx_cmp_id' => $this->cmpId, 'ctx_fy_id' => $this->fyId];

        if ($this->boId > 0) {
            $sql .= ' AND (' . $prefix . 'bo_id = :ctx_bo_id OR ' . $prefix . 'bo_id = 0)';
            $params['ctx_bo_id'] = $this->boId;
        }

        return [$sql, $params];
    }
}
