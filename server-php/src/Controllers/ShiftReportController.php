<?php

declare(strict_types=1);

namespace Aicountly\Api\Controllers;

use Aicountly\Api\Auth;
use Aicountly\Api\Context;
use Aicountly\Api\Domain\Shift\ShiftReportBoard;
use Aicountly\Api\Http;
use Aicountly\Api\Permissions;

/**
 * The Shift Report — one shift, and everything a manager has to decide about it.
 *
 * THREE ENDPOINTS, NOT NINE. The board itself is one response, because the six
 * questions on that screen are about the same shift and six round trips from a
 * tablet is six chances to render half a shift. Only the two lists that grow
 * without limit — the audit trail and the rows behind a risk tile — are paged
 * and asked for separately, when somebody actually opens them.
 *
 * PERMISSION IS CHECKED HERE, AND AGAIN IN SQL. `reports.view` sees every till
 * in the outlet. A cashier with `shift.close` sees the shifts they opened and
 * nothing else — enforced by the query in ShiftReportBoard, not by a control
 * the front end left off the screen.
 */
final class ShiftReportController extends Controller
{
    /** The whole board for one shift. */
    public static function report(): void
    {
        [$auth, $ctx] = self::enter();
        self::assertMayRead($ctx, $auth);

        Http::data(ShiftReportBoard::fromRequest($ctx, $auth)->build());
    }

    /**
     * The shift's audit trail, paged.
     *
     * Deliberately not part of the board response: a busy shift has hundreds of
     * events and a screen that downloaded all of them to show twelve is a
     * screen that stops working in the second month of trading.
     */
    public static function events(): void
    {
        [$auth, $ctx] = self::enter();
        self::assertMayRead($ctx, $auth);

        $board = ShiftReportBoard::fromRequest($ctx, $auth);
        $sessionId = $board->sessionId();
        if ($sessionId === null) {
            Http::validationFailed('Which shift?', ['field' => 'session_id']);
        }

        $params = Http::listParams(['created_at'], 'created_at');
        $result = $board->events($sessionId, Http::param('kind'), $params['limit'], $params['offset']);

        Http::list($result['items'], $result['total'], $params['limit'], $params['offset'], [
            'kinds' => $result['kinds'],
        ]);
    }

    /** The rows behind one risk tile. */
    public static function risk(): void
    {
        [$auth, $ctx] = self::enter();
        self::assertMayRead($ctx, $auth);

        $board = ShiftReportBoard::fromRequest($ctx, $auth);
        $sessionId = $board->sessionId();
        if ($sessionId === null) {
            Http::validationFailed('Which shift?', ['field' => 'session_id']);
        }

        $kind = (string) (Http::param('kind') ?? '');
        $allowed = ['voids', 'no_sale', 'override', 'refund', 'approval', 'suspicious'];
        if (!in_array($kind, $allowed, true)) {
            Http::validationFailed('That is not something this screen tracks.', ['field' => 'kind', 'allowed' => $allowed]);
        }

        $params = Http::listParams(['created_at'], 'created_at');
        $result = $board->riskDetail($sessionId, $kind, $params['limit'], $params['offset']);

        Http::list($result['rows'], $result['total'], $params['limit'], $params['offset'], [
            'kind' => $result['kind'],
            'note' => $result['note'] ?? null,
        ]);
    }

    /**
     * Who may open this screen at all.
     *
     * The same three as Cash, Shifts & Controls: a manager reads the outlet, a
     * cashier reads their own drawer. What each of them SEES is decided in the
     * query, which is the check that matters.
     */
    private static function assertMayRead(Context $ctx, Auth $auth): void
    {
        foreach (['reports.view', 'shift.close', 'shift.open'] as $permission) {
            if (Permissions::allows($ctx, $auth, $permission)) {
                return;
            }
        }

        Http::forbidden('You cannot see shift reports. Ask a manager.');
    }
}
