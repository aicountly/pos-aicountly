/**
 * The Retail Operations panels.
 *
 * One file per question the board answers, re-exported here so a page imports
 * from `panels/retail` and does not have to know which file a panel lives in.
 */

export { HeldBills, RecentTransactions } from './bills'
export { DeviceHealth, StockAttention } from './devices'
export { OperationalAlerts, RetailAttention } from './attention'
export { LiveCounterStatus } from './counters'
export { HourlySalesTrend } from './trend'
export { CheckoutHealth } from './health'
export { TopSellingCategories } from './categories'
export { ShiftReadiness } from './readiness'
