/**
 * The pre-bill — the check a guest asks for before they pay.
 *
 * It is NOT a tax invoice and says so on its face. The invoice number is a
 * statutory series that lives in Books and is minted when the sale is settled
 * at the till; printing one from the floor would be inventing it. What this
 * prints is what the table has run up so far, which is exactly what the guest
 * asked to see.
 *
 * Printed through a hidden iframe so the application behind it is untouched:
 * printing the page itself would print the floor plan.
 */

import { api } from '../../services/api'
import type { Cart } from '../../services/types'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  )
}

function inr(value: number): string {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

export interface PreBillContext {
  tableLabel: string
  floorName: string
  outletName: string
  serverName: string | null
  covers: number | null
}

function render(cart: Cart, context: PreBillContext): string {
  const lines = cart.lines
    .map(
      (line) => `
        <tr>
          <td>${escapeHtml(line.display_name)}${
            line.modifiers.length > 0
              ? `<small>${escapeHtml(line.modifiers.map((modifier) => modifier.option_name).join(', '))}</small>`
              : ''
          }</td>
          <td class="n">${line.quantity}</td>
          <td class="n">${inr(line.rate)}</td>
          <td class="n">${inr(line.line_amount)}</td>
        </tr>`,
    )
    .join('')

  const row = (label: string, value: number, strong = false) =>
    value === 0 && !strong
      ? ''
      : `<tr class="${strong ? 'total' : ''}"><td colspan="3">${label}</td><td class="n">${inr(value)}</td></tr>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pre-bill — ${escapeHtml(context.tableLabel)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px; font: 12px/1.5 ui-monospace, 'SFMono-Regular', Menlo, monospace; color: #111; }
  h1 { margin: 0 0 2px; font-size: 15px; letter-spacing: -0.01em; }
  .sub { color: #555; font-size: 11px; }
  .meta { margin: 10px 0; padding: 8px 0; border-top: 1px dashed #999; border-bottom: 1px dashed #999; }
  .meta div { display: flex; justify-content: space-between; gap: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #333; padding: 4px 0; }
  td { padding: 4px 0; vertical-align: top; }
  td small { display: block; color: #555; font-size: 10px; }
  .n { text-align: right; white-space: nowrap; }
  .total td { border-top: 1px solid #333; font-weight: 700; font-size: 13px; padding-top: 6px; }
  footer { margin-top: 14px; padding-top: 8px; border-top: 1px dashed #999; color: #555; font-size: 10px; text-align: center; }
  @page { margin: 8mm; }
</style>
</head>
<body>
  <h1>${escapeHtml(context.outletName)}</h1>
  <p class="sub">Pre-bill — not a tax invoice</p>

  <div class="meta">
    <div><span>Table</span><strong>${escapeHtml(context.tableLabel)}</strong></div>
    <div><span>Floor</span><span>${escapeHtml(context.floorName)}</span></div>
    ${context.covers ? `<div><span>Guests</span><span>${context.covers}</span></div>` : ''}
    ${context.serverName ? `<div><span>Server</span><span>${escapeHtml(context.serverName)}</span></div>` : ''}
    <div><span>Order</span><span>#ORD-${cart.cart_id}</span></div>
    <div><span>Printed</span><span>${new Date().toLocaleString('en-IN')}</span></div>
  </div>

  <table>
    <thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
    <tbody>
      ${lines || '<tr><td colspan="4">Nothing ordered yet.</td></tr>'}
      ${row('Subtotal', cart.subtotal_amount)}
      ${row('Discount', -cart.discount_amount)}
      ${row('Service charge', cart.service_charge_amount)}
      ${row('Estimated tax', cart.estimated_tax_amount)}
      ${row('Total', cart.total_amount, true)}
    </tbody>
  </table>

  <footer>
    Tax is estimated at the point of sale and is confirmed on the invoice raised when the bill is settled.
  </footer>
</body>
</html>`
}

/**
 * Fetch the table's running bill and put it in front of the printer.
 *
 * Throws when the bill cannot be read, so the caller can say so rather than
 * opening an empty print dialog.
 */
export async function printPreBill(cartId: number, context: PreBillContext): Promise<void> {
  const response = await api.one<Cart>(`v1/carts/${cartId}`)

  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)

  const doc = frame.contentDocument
  if (!doc || !frame.contentWindow) {
    frame.remove()
    throw new Error('This browser would not open a print view.')
  }

  doc.open()
  doc.write(render(response.data, context))
  doc.close()

  // Give the document a tick to lay out; printing an unlaid-out iframe prints a
  // blank page in more than one browser.
  await new Promise((resolve) => window.setTimeout(resolve, 60))

  frame.contentWindow.focus()
  frame.contentWindow.print()

  // Removed after the dialog has had time to take its copy of the document.
  window.setTimeout(() => frame.remove(), 1500)
}
