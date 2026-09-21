/**
 * The tab vocabulary, kept apart from the components so the cards, the tabs and
 * the page all filter on exactly the same words.
 */

import type { QueueRecord } from './model'

export type QueueTab = 'all' | 'ready' | 'attention' | 'failed' | 'posted'

export const TAB_ORDER: QueueTab[] = ['all', 'ready', 'attention', 'failed', 'posted']

export const TAB_LABEL: Record<QueueTab, string> = {
  all: 'All',
  ready: 'Ready',
  attention: 'Needs Attention',
  failed: 'Failed',
  posted: 'Posted',
}

/**
 * "All" means everything still owed — posted and abandoned are settled, so they
 * do not sit in a queue the cashier is being asked to clear.
 */
export function matchesTab(record: QueueRecord, tab: QueueTab): boolean {
  switch (tab) {
    case 'ready':
      return record.status === 'READY'
    case 'attention':
      return record.status === 'NEEDS_ATTENTION'
    case 'failed':
      return record.status === 'FAILED'
    case 'posted':
      return record.status === 'POSTED' || record.status === 'ABANDONED'
    default:
      return record.status !== 'POSTED' && record.status !== 'ABANDONED'
  }
}
