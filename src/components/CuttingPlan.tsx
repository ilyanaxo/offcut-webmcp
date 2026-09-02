import { useRef } from 'react';
import { OBJECTIVES, type BoardLayout, type PlanRecord, type Workspace } from '../types';
import Icon from './Icon';

type Palette = ReadonlyMap<string, number>;
const mm = (value: number) => `${value.toLocaleString('en-US')} mm`;

export function PlanReference({ id }: { id: string }) {
  return (
    <span className="reference plan-reference" title={id}>
      {id}
    </span>
  );
}

function CutOrder({ layout }: { layout: BoardLayout }) {
  const perCutKerf = layout.cuts.length ? layout.kerfMm / layout.cuts.length : 0;
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label={`Cut order for ${layout.stockLabel}`}
    >
      <table className="data-table cut-order-table">
        <caption>
          Starts are measured from the usable stock end; each part includes one subsequent saw pass.
        </caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Part</th>
            <th scope="col">Length</th>
            <th scope="col">Start</th>
            <th scope="col">Kerf</th>
          </tr>
        </thead>
        <tbody>
          {layout.cuts.map((cut, index) => (
            <tr key={`${cut.requirementId}-${cut.instance}`}>
              <td>{index + 1}</td>
              <th scope="row">
                {cut.label} <span className="small-text">#{cut.instance}</span>
              </th>
              <td>{mm(cut.lengthMm)}</td>
              <td>{mm(cut.offsetMm)}</td>
              <td>{mm(perCutKerf)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoardDiagram({
  layout,
  maximumMm,
  palette,
  expanded,
}: {
  layout: BoardLayout;
  maximumMm: number;
  palette: Palette;
  expanded: boolean;
}) {
  const perCutKerf = layout.cuts.length ? layout.kerfMm / layout.cuts.length : 0;
  return (
    <figure
      className="board-layout"
      aria-label={`Cutting layout for ${layout.stockLabel}, ${mm(layout.stockLengthMm)}`}
    >
      <figcaption className="board-caption">
        <div>
          <span className="reference">{layout.stockId}</span>
          <strong>{layout.stockLabel}</strong>
          <span className="board-kind">
            {layout.stockKind === 'offcut' ? 'Existing offcut' : 'Full board'}
          </span>
        </div>
        <span className="measurement">{mm(layout.stockLengthMm)}</span>
      </figcaption>
      <div className="board-scale" aria-hidden="true">
        <div
          className="board-track"
          style={{ width: `${(layout.stockLengthMm / maximumMm) * 100}%` }}
        >
          {layout.cuts.map((cut) => (
            <span
              className={`board-part part-tone-${palette.get(cut.requirementId) ?? 0}`}
              key={`${cut.requirementId}-${cut.instance}`}
              style={{
                left: `${(cut.offsetMm / layout.stockLengthMm) * 100}%`,
                width: `${(cut.lengthMm / layout.stockLengthMm) * 100}%`,
              }}
              title={`${cut.label} #${cut.instance}: ${mm(cut.lengthMm)}, starts at ${mm(cut.offsetMm)}`}
            >
              <span>
                {cut.label}
                <b>{cut.lengthMm}</b>
              </span>
            </span>
          ))}
          {perCutKerf > 0 &&
            layout.cuts.map((cut) => (
              <span
                className="board-kerf"
                key={`kerf-${cut.requirementId}-${cut.instance}`}
                style={{
                  left: `${((cut.offsetMm + cut.lengthMm) / layout.stockLengthMm) * 100}%`,
                  width: `${(perCutKerf / layout.stockLengthMm) * 100}%`,
                }}
                title={`${mm(perCutKerf)} saw kerf`}
              />
            ))}
          {layout.remnantMm > 0 && (
            <span
              className={`board-remnant board-remnant--${layout.remnantKind}`}
              style={{
                left: `${((layout.stockLengthMm - layout.remnantMm) / layout.stockLengthMm) * 100}%`,
                width: `${(layout.remnantMm / layout.stockLengthMm) * 100}%`,
              }}
              title={`${mm(layout.remnantMm)} ${layout.remnantKind === 'reusable' ? 'reusable remnant' : 'short scrap'}`}
            >
              <span>{layout.remnantMm}</span>
            </span>
          )}
        </div>
      </div>
      <div className="board-accounting">
        <span>
          {layout.cuts.length} {layout.cuts.length === 1 ? 'part' : 'parts'} · {mm(layout.kerfMm)}{' '}
          sawdust
        </span>
        <span>
          {layout.remnantKind === 'none'
            ? 'No remnant'
            : `${mm(layout.remnantMm)} ${layout.remnantKind === 'reusable' ? 'to keep' : 'short scrap'}`}
        </span>
      </div>
      {expanded ? (
        <CutOrder layout={layout} />
      ) : (
        <details className="cut-details">
          <summary>Cut order & exact offsets</summary>
          <CutOrder layout={layout} />
        </details>
      )}
    </figure>
  );
}

export default function CuttingPlan({
  plan,
  workspace,
  palette,
  print = false,
}: {
  plan: PlanRecord;
  workspace: Workspace;
  palette: Palette;
  print?: boolean;
}) {
  const layoutRef = useRef<HTMLElement>(null);
  const { solution } = plan;
  const { metrics, search } = solution;
  const stale = plan.basedOnRevision !== workspace.revision;
  const searchLimit = !search.provenOptimal && search.nodes >= search.limit;
  const maximumMm = Math.max(1, ...solution.layouts.map((layout) => layout.stockLengthMm));
  const parts = new Map<string, { label: string; produced: number; missing: number }>();
  for (const layout of solution.layouts) {
    for (const cut of layout.cuts) {
      const previous = parts.get(cut.requirementId);
      if (previous) previous.produced += 1;
      else parts.set(cut.requirementId, { label: cut.label, produced: 1, missing: 0 });
    }
  }
  for (const missing of solution.unfulfilled) {
    const previous = parts.get(missing.requirementId);
    if (previous) previous.missing += missing.quantity;
    else
      parts.set(missing.requirementId, {
        label: missing.label,
        produced: 0,
        missing: missing.quantity,
      });
  }
  const accounting = stale
    ? [...parts].map(([id, part]) => ({
        id,
        label: part.label,
        requested: part.produced + part.missing,
        produced: part.produced,
      }))
    : workspace.requirements.map((part) => ({
        id: part.id,
        label: part.label,
        requested: part.quantity,
        produced: parts.get(part.id)?.produced ?? 0,
      }));
  const producedCount = accounting.reduce((total, part) => total + part.produced, 0);
  const requestedCount = accounting.reduce((total, part) => total + part.requested, 0);
  const excludedIds = solution.excludedStockIds;
  const protectedStock = workspace.stock.filter((board) => board.locked);

  return (
    <div className={`cutting-plan${stale ? ' cutting-plan--stale' : ''}`} data-plan-id={plan.id}>
      {stale && (
        <div className="notice notice--warning">
          <strong>This plan is out of date.</strong>
          <p>
            It uses revision {plan.basedOnRevision}; your measurements are now at revision{' '}
            {workspace.revision}. Its old layouts remain here for reference, not approval or export.
          </p>
        </div>
      )}
      <div className="plan-proof">
        <div className="plan-proof-status">
          <span className={`badge${solution.complete ? '' : ' badge--warning'}`}>
            {solution.complete
              ? `${producedCount} / ${requestedCount} parts planned`
              : `${producedCount} / ${requestedCount} parts · incomplete`}
          </span>
          <span className="small-text">
            {solution.complete && search.provenOptimal
              ? 'Optimal for this objective'
              : searchLimit
                ? 'Search limit reached'
                : solution.complete
                  ? 'Feasible · not proven optimal'
                  : 'No complete plan found'}
          </span>
        </div>
        {!print && solution.layouts.length > 0 && (
          <button
            type="button"
            className="text-button layout-jump"
            onClick={() => {
              layoutRef.current?.focus({ preventScroll: true });
              layoutRef.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
            }}
          >
            Jump to cutting layout
            <Icon name="arrow" />
          </button>
        )}
      </div>
      <dl className="plan-metrics">
        <div>
          <dt>Stock opened</dt>
          <dd>{mm(metrics.stockUsedMm)}</dd>
        </div>
        <div>
          <dt>Finished parts</dt>
          <dd>{mm(metrics.partsMm)}</dd>
        </div>
        <div>
          <dt>Sawdust</dt>
          <dd>{mm(metrics.kerfMm)}</dd>
        </div>
        <div>
          <dt>Reusable remnants</dt>
          <dd>{mm(metrics.reusableMm)}</dd>
        </div>
        <div>
          <dt>Short scrap</dt>
          <dd>{mm(metrics.scrapMm)}</dd>
        </div>
        <div>
          <dt>Boards handled</dt>
          <dd>{metrics.boardCount.toLocaleString('en-US')}</dd>
        </div>
      </dl>
      {!solution.complete && (
        <section
          className="missing-parts"
          tabIndex={print ? undefined : -1}
          aria-label="Unfulfilled cut requirements"
        >
          <h4>Still needed</h4>
          <ul>
            {solution.unfulfilled.map((part) => (
              <li key={part.requirementId}>
                <strong>
                  {part.quantity} × {part.label}
                </strong>
                <p>{part.reason}</p>
              </li>
            ))}
          </ul>
          <p>
            {searchLimit
              ? 'The bounded search did not find a complete plan. This does not prove that no arrangement is possible.'
              : 'No complete plan was found for these measurements and allowed stock.'}{' '}
            Check lengths and quantities, add usable stock, or deliberately release a protected
            length before solving again. Partial plans cannot be approved.
          </p>
        </section>
      )}
      {solution.layouts.length > 0 && (
        <section
          ref={layoutRef}
          className="cutting-layouts"
          tabIndex={print ? undefined : -1}
          aria-label="Proportional cutting layouts"
        >
          <div className="detail-heading">
            <h4>The cutting layout</h4>
            <span className="small-text">All lengths in mm</span>
          </div>
          <ul className="part-legend">
            {[...parts]
              .filter(([, part]) => part.produced > 0)
              .map(([id, part]) => (
                <li key={id}>
                  <span
                    className={`legend-swatch part-tone-${palette.get(id) ?? 0}`}
                    aria-hidden="true"
                  />
                  {part.label}
                </li>
              ))}
            <li>
              <span className="legend-swatch legend-swatch--kerf" aria-hidden="true" />
              Sawdust
            </li>
            <li>
              <span className="legend-swatch legend-swatch--reusable" aria-hidden="true" />
              Keep
            </li>
            <li>
              <span className="legend-swatch legend-swatch--scrap" aria-hidden="true" />
              Scrap
            </li>
          </ul>
          <p className="field-hint diagram-note">
            Lengths share one proportional scale across these boards. Thin kerf strips may be
            narrower than a screen pixel; the exact cut order lists every saw pass.
          </p>
          {solution.layouts.map((layout) => (
            <BoardDiagram
              key={layout.stockId}
              layout={layout}
              maximumMm={maximumMm}
              palette={palette}
              expanded={print}
            />
          ))}
        </section>
      )}
      <div className="material-balance">
        <p>
          <strong>Every millimetre accounted for.</strong> {(metrics.utilization * 100).toFixed(1)}%
          of opened stock becomes finished parts in this proposal.
        </p>
        <p
          className="balance-equation"
          aria-label={`${mm(metrics.stockUsedMm)} stock equals ${mm(metrics.partsMm)} parts plus ${mm(metrics.kerfMm)} sawdust plus ${mm(metrics.reusableMm)} reusable remnants plus ${mm(metrics.scrapMm)} short scrap`}
        >
          {mm(metrics.stockUsedMm)} = {metrics.partsMm.toLocaleString('en-US')} +{' '}
          {metrics.kerfMm.toLocaleString('en-US')} + {metrics.reusableMm.toLocaleString('en-US')} +{' '}
          {metrics.scrapMm.toLocaleString('en-US')} mm
        </p>
        <p className="field-hint">
          Waste is sawdust + short scrap ({mm(metrics.kerfMm + metrics.scrapMm)}). Reusable remnants
          and untouched stock are not waste.
        </p>
      </div>
      <p className="kerf-tradeoff">
        For a fixed complete job, sawdust is constant: one kerf per requested part. The trade-offs
        are stock opened, boards handled, and whether remaining lengths become reusable remnants or
        short scrap.
      </p>
      <section
        className="quantity-accounting"
        aria-label="Requested and planned quantity accounting"
      >
        <div className="detail-heading">
          <h4>Every copy checked</h4>
          <span className="small-text">
            {producedCount} planned / {requestedCount} requested
          </span>
        </div>
        {stale && (
          <p className="field-hint">
            These quantities describe the retained proposal, not your changed cut list.
          </p>
        )}
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Part quantity accounting"
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Part</th>
                <th scope="col">Requested</th>
                <th scope="col">Planned</th>
                <th scope="col">Missing</th>
              </tr>
            </thead>
            <tbody>
              {accounting.map((part) => (
                <tr key={part.id}>
                  <th scope="row">{part.label}</th>
                  <td>{part.requested}</td>
                  <td>{part.produced}</td>
                  <td className={part.requested > part.produced ? 'text-warning' : undefined}>
                    {Math.max(0, part.requested - part.produced)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {(protectedStock.length > 0 || excludedIds.length > 0) && (
        <section className="excluded-stock" aria-label="Protected and excluded stock">
          <Icon name="lock" />
          <div>
            <h4>{stale ? 'Restrictions & current protection' : 'Left out of this plan'}</h4>
            {protectedStock.length > 0 && (
              <p>
                <strong>{stale ? 'Currently protected' : 'Protected stock'}:</strong>{' '}
                {protectedStock
                  .map((board) => `${board.label} (${board.id}, ${mm(board.lengthMm)})`)
                  .join('; ')}
                .
              </p>
            )}
            {excludedIds.length > 0 && (
              <p>
                <strong>Recorded exclusions:</strong>{' '}
                {excludedIds
                  .map((id) => {
                    const board = workspace.stock.find((entry) => entry.id === id);
                    return board && !stale ? `${board.label} (${id})` : id;
                  })
                  .join('; ')}
                .
              </p>
            )}
            {stale && (
              <p>Current protections do not make an old proposal usable. Find a fresh plan.</p>
            )}
          </div>
        </section>
      )}
      <div className="search-note">
        <p>
          <strong>Deterministic branch-and-bound.</strong> {search.nodes.toLocaleString('en-US')} of{' '}
          {search.limit.toLocaleString('en-US')} search nodes examined.{' '}
          {solution.complete && search.provenOptimal
            ? 'The search proved this solution optimal for the selected objective and allowed stock.'
            : solution.complete
              ? 'This complete solution is feasible, but optimality has not been proved.'
              : 'No complete solution is being released.'}
        </p>
        <p>
          {OBJECTIVES[solution.objective].description}{' '}
          {solution.objective === 'least_stock'
            ? 'Ties favor less waste, then fewer boards.'
            : solution.objective === 'fewest_boards'
              ? 'Ties favor less stock, then less waste.'
              : 'Ties favor less stock, then fewer boards.'}
        </p>
      </div>
    </div>
  );
}

export function PlanComparison({
  plans,
  revision,
  selectedId,
  approvedId,
  reviewId,
  onSelect,
}: {
  plans: PlanRecord[];
  revision: number;
  selectedId: string | null;
  approvedId: string | null;
  reviewId: string | null;
  onSelect: (id: string) => void;
}) {
  if (plans.length < 2) return null;
  return (
    <details className="plan-comparison" open>
      <summary>
        Compare alternatives <span className="reference">{plans.length} proposals</span>
      </summary>
      <ul className="comparison-list" aria-label="Cutting plan comparison">
        {plans.map((plan) => {
          const stale = plan.basedOnRevision !== revision;
          const status = stale
            ? `Stale · rev ${plan.basedOnRevision}`
            : !plan.solution.complete
              ? 'Incomplete'
              : plan.id === approvedId
                ? 'Approved'
                : plan.id === reviewId
                  ? 'In review'
                  : 'Complete draft';
          const { metrics } = plan.solution;
          return (
            <li
              key={plan.id}
              className={`comparison-option${selectedId === plan.id ? ' comparison-row--selected' : ''}`}
            >
              <div className="comparison-heading">
                <button
                  type="button"
                  className="plan-choice"
                  aria-pressed={selectedId === plan.id}
                  aria-label={`View ${OBJECTIVES[plan.solution.objective].label} plan ${plan.id}`}
                  onClick={() => onSelect(plan.id)}
                >
                  <span>{OBJECTIVES[plan.solution.objective].label}</span>
                  <PlanReference id={plan.id} />
                </button>
                <div className="comparison-state">
                  <span
                    className={`comparison-status${stale || !plan.solution.complete ? ' text-warning' : ''}`}
                  >
                    {status}
                  </span>
                  <span className="reference">
                    {plan.solution.layouts.reduce((total, layout) => total + layout.cuts.length, 0)}{' '}
                    parts · {plan.solution.excludedStockIds.length} excluded
                  </span>
                </div>
              </div>
              <dl className="comparison-metrics">
                <div>
                  <dt>Stock opened</dt>
                  <dd>{mm(metrics.stockUsedMm)}</dd>
                </div>
                <div>
                  <dt>Boards</dt>
                  <dd>{metrics.boardCount}</dd>
                </div>
                <div>
                  <dt>Waste</dt>
                  <dd>{mm(metrics.kerfMm + metrics.scrapMm)}</dd>
                </div>
                <div>
                  <dt>Reusable</dt>
                  <dd>{mm(metrics.reusableMm)}</dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
      <p className="field-hint">
        Waste = sawdust + short scrap, not all leftover material. Compare complete plans at the same
        revision with the same exclusions; older or incomplete proposals do not fulfill the same
        job.
      </p>
    </details>
  );
}

export function PrintableCutSheet({
  plan,
  workspace,
  palette,
  unfinishedMeasurements,
}: {
  plan: PlanRecord | null;
  workspace: Workspace;
  palette: Palette;
  unfinishedMeasurements: boolean;
}) {
  const usable =
    !unfinishedMeasurements &&
    plan &&
    plan.solution.complete &&
    plan.basedOnRevision === workspace.revision;
  return (
    <article
      className="print-sheet"
      data-testid="approved-print-sheet"
      data-plan-id={usable ? plan.id : undefined}
      aria-label="Approved printable cut sheet"
    >
      {usable ? (
        <>
          <header className="print-header">
            <p className="eyebrow">Offcut / Human-approved cut sheet</p>
            <h1>{workspace.title}</h1>
            <p>{workspace.material}</p>
            <p className="reference">
              {plan.id} · workspace revision {workspace.revision} · plan created{' '}
              {new Date(plan.createdAt).toLocaleString('en-US')}
            </p>
          </header>
          <div className="print-constraints">
            <p>
              <strong>Saw kerf:</strong> {mm(workspace.settings.kerfMm)} per part.{' '}
              <strong>Keep positive remnants:</strong> at least{' '}
              {mm(workspace.settings.minReusableMm)}.
            </p>
            <p>
              Usable lengths only; deduct trimming and defects first. One saw pass per produced
              part, including the last one. Same material and cross-section throughout.
            </p>
          </div>
          <CuttingPlan plan={plan} workspace={workspace} palette={palette} print />
          <footer className="print-footer">
            A planning estimate, not machine-control instructions or a safe-cutting guarantee.
            Verify measurements, stock identity and safe workholding at the bench. Approval does not
            physically consume stock.
          </footer>
        </>
      ) : (
        <>
          <p className="eyebrow">Offcut</p>
          <h1>
            {unfinishedMeasurements
              ? 'Finish your measurement edits first'
              : 'No approved cut sheet'}
          </h1>
          <p>
            {unfinishedMeasurements
              ? 'Return to the workbench and save or cancel unfinished field edits and new rows. If the saved measurements change, find and approve a fresh complete plan before printing.'
              : 'Return to the workbench, find a complete plan for the current measurements, and review and approve it yourself. Draft, incomplete and stale plans cannot be printed as cut sheets.'}
          </p>
        </>
      )}
    </article>
  );
}
