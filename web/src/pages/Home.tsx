/**
 * The POS home screen.
 *
 * The first thing anyone sees after signing in, and the screen this product is
 * judged on: what the counter took today, whether it can sell right now, what
 * is in the way, and what to do next — in that order, because that is the order
 * a shop cares about.
 *
 * It composes existing endpoints only (see useHomeData) and every widget fails,
 * empties and loads on its own. One board being slow or forbidden leaves the
 * rest of the page working, which is the difference between a home screen and a
 * report.
 */

import { CloudOff, UploadCloud } from 'lucide-react'
import { usePos } from '../context/PosContext'
import { HomeGreeting } from '../home/parts/greeting'
import { HomeHero } from '../home/parts/hero'
import { HomeKpis } from '../home/parts/kpis'
import { SalesTrendCard, TopItemsCard } from '../home/parts/analytics'
import { OutletReadinessCard, StaffShiftCard } from '../home/parts/operations'
import { SuggestionsCard } from '../home/parts/suggestions'
import { SystemHealthCard } from '../home/parts/health'
import { HomePageSkeleton } from '../home/parts/states'
import { useHomeData } from '../home/useHomeData'
import '../home/home.css'

export default function Home() {
  const { session, terminal, terminalId, setTerminalId } = usePos()
  const model = useHomeData()

  const terminals = session?.terminals ?? []
  const locations = session?.locations ?? []
  const canReports = model.can('reports.view')
  const canSell = model.can('sell')

  // The hero decides what it is from the session. Until that has answered,
  // every state it could pick would be a guess about this shop.
  if (model.loading) return <HomePageSkeleton />

  return (
    <div className="pos-home">
      <div className="pos-home__section">
        <HomeGreeting name={model.greetingName} subtitle="Here's what's happening at your store today." />
      </div>

      {/* Not a blocker. A till that cannot reach the server can still sell, and
          this says what happens to those sales rather than stopping anyone. */}
      {!model.connection.online && (
        <div className="pos-home__section home-alert" role="status">
          <CloudOff size={17} aria-hidden />
          <span>
            <strong>You're offline.</strong>
            Selling continues — sales are kept on this till and sent up the moment the connection is back. Figures on
            this page are the last ones read.
          </span>
        </div>
      )}

      {model.connection.online && model.connection.queued > 0 && (
        <div className="pos-home__section home-alert" role="status">
          <UploadCloud size={17} aria-hidden />
          <span style={{ flex: 1 }}>
            <strong>
              {model.connection.queued} sale{model.connection.queued === 1 ? '' : 's'} still on this till.
            </strong>
            Taken while offline and waiting to go up. Each carries an id, so sending it twice cannot bill it twice.
          </span>
          <button
            type="button"
            className="home-btn home-btn--small"
            onClick={() => void model.connection.sync()}
            disabled={model.connection.syncing}
          >
            {model.connection.syncing ? 'Sending…' : 'Send now'}
          </button>
        </div>
      )}

      <div className="pos-home__section">
        <HomeKpis
          figures={model.kpis}
          loading={model.kpisLoading}
          restricted={model.kpisRestricted}
          tills={terminals.length}
          returns={{ loading: model.returnsLoading, allowed: model.canReturns, failed: model.returnsError !== null }}
          can={model.can}
        />
      </div>

      <div className="pos-home__section home-primary">
        <HomeHero
          kind={model.hero}
          terminals={terminals}
          locations={locations}
          terminal={terminal}
          shift={model.shift}
          queued={model.connection.queued}
          online={model.connection.online}
          health={model.health.rows}
          can={model.can}
          onChooseTill={setTerminalId}
        />
        <SystemHealthCard
          rows={model.health.rows}
          summary={model.health.summary}
          loading={model.retailLoading && terminalId === null}
        />
      </div>

      <div className="pos-home__section home-secondary">
        <SalesTrendCard
          board={model.overview}
          loading={model.overviewLoading}
          error={model.overviewError}
          onRetry={model.refresh}
          allowed={canReports}
        />
        <TopItemsCard
          board={model.overview}
          loading={model.overviewLoading}
          error={model.overviewError}
          onRetry={model.refresh}
          allowed={canReports}
        />

        <div className="home-column">
          <OutletReadinessCard
            outlets={model.outlets}
            loading={model.loading}
            canManage={model.can('terminal.manage')}
          />
          <StaffShiftCard
            shifts={model.shifts}
            loading={model.retailLoading}
            error={model.retailError}
            onRetry={model.refresh}
            allowed={canReports || canSell}
            canReports={canReports}
          />
        </div>

        <SuggestionsCard
          suggestions={model.suggestions}
          loading={model.overviewLoading && model.suggestions.length === 0}
        />
      </div>
    </div>
  )
}
