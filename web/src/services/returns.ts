/**
 * Everything the Returns workspace asks the server for.
 *
 * ONE place, so that no component holds a URL. The rules this file keeps:
 *
 *  - Company, branch and financial year are never passed here. `api` puts the
 *    scope on every call from the context the app already holds, so a screen
 *    cannot accidentally read another company's returns by forgetting a
 *    parameter — or by remembering the wrong one.
 *  - Nothing is cached. A return is money; a stale figure on this screen is a
 *    refund given twice.
 *  - Totals are read, not computed. The KPIs, the trend, the reasons and the
 *    channels are all aggregated by PostgreSQL over the same filter the table
 *    uses, so the numbers above the register always describe the rows in it.
 */

import { api, type ListResponse, type QueryParams } from './api'
import type { Cart, CatalogItem, PosReturn, RegisterSession } from './types'
import type {
  NewReturnPayload,
  ReturnAuditEntry,
  ReturnEligibility,
  ReturnRow,
  ReturnsSummary,
} from '../returns/types'

/** The most rows the API will return in one page — `Http::MAX_LIMIT` on the server. */
export const MAX_PAGE = 200

/** How far an export will page before it stops and says so. 10 × 200 = 2,000 rows. */
const EXPORT_PAGE_LIMIT = 10

export interface ExportResult {
  rows: ReturnRow[]
  total: number
  /** True when the export stopped at the cap and does not hold every matching row. */
  truncated: boolean
}

export const returnsService = {
  /** One page of the register. Filters, paging and sorting are all server-side. */
  list: (params: QueryParams, signal?: AbortSignal) => api.list<ReturnRow>('v1/returns', params, signal),

  /** The KPIs, the trend and the breakdowns, over the same filter as `list`. */
  summary: (params: QueryParams, signal?: AbortSignal) => api.one<ReturnsSummary>('v1/returns/summary', params, signal),

  one: (returnId: number, signal?: AbortSignal) => api.one<PosReturn>(`v1/returns/${returnId}`, undefined, signal),

  /** What a given sale still has coming back, by the rule the server enforces on submit. */
  eligibility: (cartId: number, signal?: AbortSignal) =>
    api.one<ReturnEligibility>('v1/returns/eligibility', { cart_id: cartId }, signal),

  create: (payload: NewReturnPayload) => api.post<PosReturn>('v1/returns', payload),

  /** Approve, take the goods back, raise the credit note. Each is its own decision. */
  advance: (returnId: number, step: 'approve' | 'receive' | 'settle') =>
    api.post<PosReturn>(`v1/returns/${returnId}/${step}`, {}),

  /** Completed sales to return against. POS' own carts — no invoice list is kept here. */
  findSales: (term: string, signal?: AbortSignal) =>
    api.list<Cart>('v1/carts', { status: 'COMPLETED', q: term, limit: 10 }, signal),

  recentSales: (signal?: AbortSignal) => api.list<Cart>('v1/carts', { status: 'COMPLETED', limit: 8 }, signal),

  /** Inventory's items, read through this product. Nothing it returns is stored. */
  searchItems: (term: string, signal?: AbortSignal) =>
    api.one<CatalogItem[]>('v1/catalog/items/search', { q: term, limit: 12 }, signal),

  /**
   * The shift open on a till right now.
   *
   * A cash refund comes out of the drawer that is open NOW, not the one the
   * original sale was rung up on — which may have been counted and closed days
   * ago. The new-return flow sends this session id so the server debits the
   * right drawer.
   */
  currentShift: (terminalId: number, signal?: AbortSignal) =>
    api.one<{ session: RegisterSession | null }>('v1/shifts/current', { terminal_id: terminalId }, signal),

  /**
   * The replacement half of an exchange.
   *
   * An exchange is a return plus a NEW SALE, and the sale is a sale like any
   * other: it is rung up on the till, priced by Inventory and invoiced by Books.
   * These three calls build that sale and park it on the till for the cashier to
   * take payment on — nothing here prices, taxes or invoices anything itself.
   */
  openCart: (body: Record<string, unknown>) => api.post<Cart>('v1/carts', body),
  addCartLine: (cartId: number, body: Record<string, unknown>) => api.post<Cart>(`v1/carts/${cartId}/lines`, body),
  holdCart: (cartId: number, label: string) => api.post<Cart>(`v1/carts/${cartId}/hold`, { hold_label: label }),

  /**
   * What was done to this return, and by whom.
   *
   * The shared audit log, filtered to one entity. It needs `reports.view`,
   * which a cashier does not have — the caller checks before asking, and the
   * section is absent rather than empty for anyone who may not see it.
   */
  auditTrail: (returnId: number, signal?: AbortSignal) =>
    api.list<ReturnAuditEntry>('v1/audit-log', { entity_type: 'return', entity_id: returnId, limit: 25 }, signal),

  /**
   * Every row matching the current filter, for a spreadsheet.
   *
   * TODO(api): there is no server-side export endpoint on this product yet. When
   * one exists (`GET v1/returns/export` returning a file the browser downloads),
   * replace this with a call to it: paging the register client-side is honest
   * but bounded, and a shop with a long tail of returns is told when the file it
   * downloaded stops short rather than being handed a quiet truncation.
   */
  async exportRows(params: QueryParams, signal?: AbortSignal): Promise<ExportResult> {
    const rows: ReturnRow[] = []
    let offset = 0
    let total = 0

    for (let page = 0; page < EXPORT_PAGE_LIMIT; page += 1) {
      const response: ListResponse<ReturnRow> = await api.list<ReturnRow>(
        'v1/returns',
        { ...params, limit: MAX_PAGE, offset },
        signal,
      )
      total = response.meta.total
      rows.push(...response.data)
      offset += MAX_PAGE

      if (rows.length >= total || response.data.length === 0) {
        return { rows, total, truncated: false }
      }
    }

    return { rows, total, truncated: rows.length < total }
  },
}
