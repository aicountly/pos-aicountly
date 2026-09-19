/**
 * The things a person can actually do from here.
 *
 * WHAT IS NOT IN THIS ROW, and why. Import customers, loyalty programmes and
 * campaign sending are all on the mock this screen was built to; none of them
 * exists in POS. A tile that opens nothing, or opens a "coming soon" dialog, is
 * worse than no tile: it costs a click to learn the product cannot do the thing,
 * every time. The absences are stated once, properly, on the Loyalty and offers
 * panel further down — which is a sentence explaining the gap rather than a
 * button that disappoints.
 *
 * So every tile here goes somewhere real, and each is filtered by the
 * permission that its destination enforces anyway.
 */

import { BarChart3, ChartColumnBig, Receipt, Store, UserPlus } from 'lucide-react'
import { CardLink } from './parts'

export function CustomerQuickActions({
  can,
  retailHref,
}: {
  can: (permission: string) => boolean
  retailHref: string
}) {
  const actions = [
    {
      id: 'till',
      to: '/',
      tone: 'brand',
      icon: <UserPlus size={17} strokeWidth={2} />,
      title: 'Attach a customer',
      description: 'Open the till and put a customer on the bill',
      allowed: can('sell'),
    },
    {
      id: 'counter',
      to: retailHref,
      tone: 'info',
      icon: <Store size={17} strokeWidth={2} />,
      title: 'Counter activity',
      description: 'Which tills are identifying customers',
      allowed: can('reports.view') || can('sell'),
    },
    {
      id: 'overview',
      to: '/overview',
      tone: 'violet',
      icon: <ChartColumnBig size={17} strokeWidth={2} />,
      title: 'Business overview',
      description: 'Where the rest of the takings came from',
      allowed: can('reports.view'),
    },
    {
      id: 'reports',
      to: '/reports',
      tone: 'amber',
      icon: <BarChart3 size={17} strokeWidth={2} />,
      title: 'Reports',
      description: 'Till and shift reporting',
      allowed: can('reports.view'),
    },
    {
      id: 'returns',
      to: '/returns',
      tone: 'rose',
      icon: <Receipt size={17} strokeWidth={2} />,
      title: 'Returns',
      description: 'What came back, and from whom',
      allowed: can('return.create') || can('reports.view'),
    },
  ].filter((action) => action.allowed)

  if (actions.length === 0) return null

  return (
    <section className="cg-actions" aria-label="Customer actions">
      {actions.map((action) => (
        <CardLink
          key={action.id}
          to={action.to}
          tone={action.tone}
          icon={action.icon}
          title={action.title}
          description={action.description}
        />
      ))}
    </section>
  )
}
