<?php

declare(strict_types=1);

namespace Aicountly\Api;

/**
 * Who is calling.
 *
 * Two ways in, exactly as Books and Inventory accept:
 *
 *  1. A human — `Authorization: Bearer <ses_key>`, validated at my.aicountly.com.
 *     The ses_key is kept so this product can call Books and Inventory AS THAT
 *     USER, which is what makes their permissions apply over there instead of
 *     this product having to re-implement them.
 *
 *  2. A trusted product backend — `X-Service-Key`, plus `X-Actor-Uuid` naming the
 *     human it is acting for, for the audit trail.
 *
 * `source_app` is decided HERE and never read from a header: a service key
 * resolves to its product, a human session is always this product. A body that
 * claims to be another app is a caller trying to mint another product's
 * document, and it gets a 403.
 */
final class Auth
{
    /** Lazily-fetched portal profile, cached for the life of this instance. */
    private bool $profileFetched = false;
    /** @var array<string, mixed>|null */
    private ?array $profileCache = null;

    private function __construct(
        public readonly string $uuid,
        public readonly string $kind,      // 'user' | 'service'
        public readonly string $sourceApp,
        private readonly string $sesKey,
        private array $session,
    ) {
    }

    /** Resolve the caller, or answer 401 and stop. */
    public static function require(): self
    {
        $resolved = self::resolve();
        if ($resolved === null) {
            Http::unauthorized();
        }

        return $resolved;
    }

    public static function resolve(): ?self
    {
        $serviceKey = Http::header('X-Service-Key');
        if ($serviceKey !== '') {
            $app = ServiceKeys::resolveApp($serviceKey);
            if ($app === null) {
                return null;
            }
            // Proven by the key, not claimed in a header. Recording it is what
            // stops us calling that product back inside its own request.
            CrossServiceCallContext::adoptAuthenticatedOrigin($app);
            $actor = Http::header('X-Actor-Uuid');

            return new self(
                $actor !== '' ? $actor : 'service:' . $app,
                'service',
                $app,
                '',
                [],
            );
        }

        $sesKey = self::bearer();
        if ($sesKey === '') {
            return null;
        }

        $session = Portal::validateSesKey($sesKey);
        if ($session === null) {
            return null;
        }

        return new self(
            (string) ($session['uuid_aictly'] ?? $session['uuid'] ?? ''),
            'user',
            Env::get('APP_PRODUCT_KEY', 'pos'),
            $sesKey,
            $session,
        );
    }

    public function isService(): bool
    {
        return $this->kind === 'service';
    }

    /**
     * The session key, for calling Books / Inventory as this user.
     *
     * Empty for a service caller, which is correct: a service acts with its own
     * key over there, not with a borrowed human session.
     */
    public function sesKey(): string
    {
        return $this->sesKey;
    }

    /** Stable per-session identifier for memo keys. Never the key itself, which must not reach a log or a cache key. */
    public function fingerprint(): string
    {
        return substr(hash('sha256', $this->kind . '|' . $this->uuid . '|' . $this->sesKey), 0, 32);
    }

    /**
     * Access type for the company being opened: 1 = owner, 0 = delegated.
     *
     * WHERE THIS COMES FROM, because it is not obvious and getting it wrong
     * locked every user out of this product.
     *
     * `acs_type` is a COMPANY MEMBERSHIP fact — whether *this* person owns
     * *that* company. The portal's `validatesession` cannot know it: it is
     * handed a session key and no company, so it answers about the user and
     * nothing else. Manage is what knows, and it says so on the company row.
     *
     * So this reads whatever the portal happened to send, and Context promotes
     * it from Manage's answer on the request that names a company. Before that
     * promotion existed this method returned null for every human being alive,
     * the `accessType() === 1` owner branch in Permissions::granted() never
     * ran, and a company owner signing in for the first time got an empty
     * permission list, an empty navigation and no way to reach the screen that
     * would have granted them one.
     */
    public function accessType(): ?int
    {
        return isset($this->session['acs_type']) ? (int) $this->session['acs_type'] : null;
    }

    /**
     * Record what Manage says this person is on this company.
     *
     * UPGRADES ONLY. A promotion may turn an unknown into an owner; it may
     * never turn an owner into anything else. Manage being unreachable, or
     * answering in a shape this code does not recognise, has to leave the
     * session exactly as it was — the alternative is a bad minute at Manage
     * silently demoting an owner mid-session.
     *
     * Returns whether anything actually changed, so the caller can drop a
     * permission list that was worked out before the promotion.
     */
    public function promoteAccessType(?int $acsType): bool
    {
        if ($acsType === null || $this->accessType() === 1 || $this->accessType() === $acsType) {
            return false;
        }

        $this->session['acs_type'] = $acsType;

        return true;
    }

    public function displayName(): string
    {
        foreach (['name', 'full_name', 'user_name', 'email'] as $field) {
            $value = $this->session[$field] ?? null;
            if (is_string($value) && $value !== '') {
                return $value;
            }
        }

        // `validatesession` answered with no name at all — the same gap Smart
        // Books hits for its own header, and closes by reading the portal's
        // profile endpoint instead of the bare session. Same call, same field
        // order, so this shows the same name Books would show this person.
        $profile = $this->profile();
        if ($profile !== null) {
            foreach (['full_name', 'first_name', 'user_firstname', 'email', 'reg_email'] as $field) {
                $value = $profile[$field] ?? null;
                if (is_string($value) && trim($value) !== '') {
                    return trim($value);
                }
            }
        }

        return $this->uuid;
    }

    /**
     * The portal's profile answer for this session, fetched once and kept for
     * the rest of the request — never more than the one extra round trip
     * `displayName()` needs when the session itself carries no name.
     *
     * @return array<string, mixed>|null
     */
    private function profile(): ?array
    {
        if (!$this->profileFetched) {
            $this->profileFetched = true;
            $this->profileCache = $this->sesKey !== '' ? Portal::fetchUserProfile($this->sesKey) : null;
        }

        return $this->profileCache;
    }

    private static function bearer(): string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (!is_string($header) || $header === '') {
            if (function_exists('apache_request_headers')) {
                foreach ((array) apache_request_headers() as $name => $value) {
                    if (strcasecmp((string) $name, 'Authorization') === 0) {
                        $header = (string) $value;
                        break;
                    }
                }
            }
        }
        if (!is_string($header) || preg_match('/Bearer\s+(.+)/i', $header, $m) !== 1) {
            return '';
        }

        return trim($m[1]);
    }
}
