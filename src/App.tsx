import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from './errors';
import { exportApprovedPlan } from './export';
import {
  OBJECTIVES,
  LIMITS,
  type Actor,
  type BridgeState,
  type Objective,
  type WorkshopStore,
} from './types';
import CuttingPlan, {
  PlanComparison,
  PlanReference,
  PrintableCutSheet,
  formatPlanDateTime,
  formatNumber,
} from './components/CuttingPlan';
import Dialog from './components/Dialog';
import Icon from './components/Icon';
import WorkbenchEditors from './components/WorkbenchEditors';

const AGENT_PROMPT =
  'Inspect my Offcut workshop. Compare complete plans for all three objectives: least_stock, fewest_boards, and least_waste. Account separately for sawdust, short scrap, and reusable remnants. Respect protected stock and the current kerf/reusable-remnant settings. Stage the least-stock plan for my review; do not approve it.';
const ACTOR_LABELS: Record<Actor, string> = { human: 'You', webmcp: 'WebMCP', system: 'System' };
const BRIDGE_LABELS: Record<BridgeState['state'], string> = {
  checking: 'Checking native WebMCP',
  ready: 'Native WebMCP ready',
  unsupported: 'Manual mode · WebMCP unavailable',
  error: 'Native WebMCP registration error',
};
const TOOL_NAMES = [
  'get_workshop',
  'plan_cuts',
  'inspect_plan',
  'compare_plans',
  'stage_plan_for_review',
  'export_cut_list',
] as const;

const activityTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function BenchIllustration() {
  return (
    <svg
      className="bench-illustration"
      viewBox="0 0 320 176"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M24 156h272" stroke="var(--line-strong)" />
      <g transform="rotate(-8 160 88)">
        <path d="M36 80h246v44H36z" fill="var(--timber)" stroke="var(--ochre)" />
        <path
          d="M36 124v10h246v-10M46 96c28-13 42 10 70 0s43-4 63 1 56-12 91-2M45 112c23-9 40 9 67 0s56-2 82 0 49-6 77-3"
          stroke="var(--ochre)"
        />
        <path d="M126 80v44m5-44v44" stroke="var(--paper-raised)" strokeWidth="3" />
        <path d="M40 48h210v22H40z" fill="var(--paper-raised)" stroke="var(--forest)" />
        <path
          d="M52 48v13m12-13v7m12-7v7m12-7v13m12-13v7m12-7v7m12-7v13m12-13v7m12-7v7m12-7v13m12-13v7m12-7v7m12-7v13m12-13v7m12-7v7m12-7v13"
          stroke="var(--forest)"
        />
      </g>
      <path d="m238 26 48 28-5 9-48-28-7-10z" fill="var(--forest)" stroke="var(--forest)" />
      <path d="m226 25 7 10 5-9z" fill="var(--timber)" />
      <path
        d="M46 146h34m-25-5 3 10m9-11 3 10m150-10 5 6m11-8 4 9m12-7 6 6"
        stroke="var(--ochre)"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function App({ store }: { store: WorkshopStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { workspace, pendingMeasurements } = snapshot;
  const [objective, setObjective] = useState<Objective>('least_stock');
  const [solving, setSolving] = useState(false);
  const solvingTimer = useRef<number | null>(null);
  const humanResultRef = useRef<string | null>(null);
  const selectedProposalRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<'sample' | 'clear' | null>(null);
  const confirmationInvoker = useRef<HTMLElement | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [acknowledgedReview, setAcknowledgedReview] = useState<string | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const previousSession = useRef({
    revision: workspace.revision,
    reviewId: snapshot.reviewPlanId,
    approvedId: snapshot.approvedPlanId,
  });
  const selectedPlan = snapshot.plans.find((plan) => plan.id === snapshot.selectedPlanId) ?? null;
  const stagedPlan = snapshot.plans.find((plan) => plan.id === snapshot.reviewPlanId) ?? null;
  const approvedRecord = snapshot.plans.find((plan) => plan.id === snapshot.approvedPlanId) ?? null;
  const approvedPlan =
    approvedRecord?.solution.complete && approvedRecord.basedOnRevision === workspace.revision
      ? approvedRecord
      : null;
  const reviewKey = stagedPlan ? `${stagedPlan.id}@${stagedPlan.basedOnRevision}` : null;
  const reviewRevokesApproval = Boolean(stagedPlan && approvedPlan?.id === stagedPlan.id);
  const reviewEligible = Boolean(
    stagedPlan?.solution.complete &&
    stagedPlan.basedOnRevision === workspace.revision &&
    snapshot.reviewPlanId === stagedPlan.id &&
    !pendingMeasurements &&
    !solving,
  );
  const requestedParts = workspace.requirements.reduce((total, part) => total + part.quantity, 0);
  const protectedStock = useMemo(
    () => workspace.stock.filter((board) => board.locked),
    [workspace.stock],
  );
  const protectedStockIds = useMemo(
    () => protectedStock.map((board) => board.id),
    [protectedStock],
  );
  const availableStockCount = workspace.stock.length - protectedStock.length;
  const palette = useMemo(() => {
    const colors = new Map<string, number>();
    for (const part of workspace.requirements) colors.set(part.id, colors.size % 8);
    for (const plan of snapshot.plans) {
      for (const layout of plan.solution.layouts) {
        for (const cut of layout.cuts)
          if (!colors.has(cut.requirementId)) colors.set(cut.requirementId, colors.size % 8);
      }
    }
    return colors;
  }, [workspace.requirements, snapshot.plans]);
  const activity = useMemo(() => snapshot.events.toReversed(), [snapshot.events]);

  const showError = useCallback((cause: unknown) => {
    setError(errorMessage(cause));
    setFeedback(null);
  }, []);

  useEffect(
    () => () => {
      if (solvingTimer.current !== null) window.clearTimeout(solvingTimer.current);
    },
    [],
  );
  useEffect(() => {
    const previous = previousSession.current;
    if (previous.revision !== workspace.revision && (previous.reviewId || previous.approvedId)) {
      setFeedback(
        'Measurements changed. Any review or approval for the previous revision has been invalidated; find a fresh plan.',
      );
    }
    previousSession.current = {
      revision: workspace.revision,
      reviewId: snapshot.reviewPlanId,
      approvedId: snapshot.approvedPlanId,
    };
  }, [workspace.revision, snapshot.reviewPlanId, snapshot.approvedPlanId]);
  useEffect(() => {
    setAcknowledgedReview(null);
    setReviewError(null);
  }, [snapshot.reviewPlanId]);
  useEffect(() => {
    const planId = humanResultRef.current;
    if (!planId || solving) return;
    humanResultRef.current = null;
    const current = store.getSnapshot();
    if (
      snapshot.selectedPlanId !== planId ||
      current.selectedPlanId !== planId ||
      current.reviewPlanId ||
      confirmation !== null ||
      current.pendingMeasurements
    )
      return;
    const plan = current.plans.find((candidate) => candidate.id === planId);
    if (!plan || plan.basedOnRevision !== current.workspace.revision) return;
    const target = selectedProposalRef.current?.querySelector<HTMLElement>(
      plan.solution.complete ? '.cutting-layouts' : '.missing-parts',
    );
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: 'instant', block: 'start' });
  }, [
    store,
    solving,
    snapshot.selectedPlanId,
    snapshot.reviewPlanId,
    workspace.revision,
    confirmation,
  ]);

  const run = useCallback(
    (operation: () => void) => {
      setError(null);
      try {
        operation();
      } catch (cause) {
        showError(cause);
      }
    },
    [showError],
  );
  const selectPlan = useCallback((id: string) => run(() => store.selectPlan(id)), [run, store]);

  function requireSavedMeasurements() {
    if (store.getSnapshot().pendingMeasurements)
      throw new Error(
        'Finish or cancel your measurement edits before planning, reviewing or releasing a cut sheet.',
      );
  }

  function findPlan() {
    if (solving) return;
    setError(null);
    setFeedback(null);
    try {
      requireSavedMeasurements();
    } catch (cause) {
      showError(cause);
      return;
    }
    const expectedRevision = store.getSnapshot().workspace.revision;
    setSolving(true);
    solvingTimer.current = window.setTimeout(() => {
      solvingTimer.current = null;
      try {
        const plan = store.proposePlan({ expectedRevision, objective }, 'human');
        humanResultRef.current = plan.id;
        const count = plan.solution.layouts.reduce(
          (total, layout) => total + layout.cuts.length,
          0,
        );
        setFeedback(
          plan.solution.complete
            ? `${OBJECTIVES[plan.solution.objective].label}: complete proposal created for ${count} parts on ${plan.solution.metrics.boardCount} stock lengths. Review it before releasing a cut sheet.`
            : `Incomplete proposal: ${count} parts planned. See the unfulfilled requirements; this proposal cannot be approved.`,
        );
      } catch (cause) {
        showError(cause);
      } finally {
        setSolving(false);
      }
    }, 0);
  }

  function stageSelectedPlan() {
    run(() => {
      requireSavedMeasurements();
      if (!selectedPlan) throw new Error('Find or select a complete cutting plan first.');
      const current = store.getSnapshot();
      store.stagePlan(selectedPlan.id, current.workspace.revision, 'human');
    });
  }

  function approveReviewedPlan() {
    setReviewError(null);
    try {
      requireSavedMeasurements();
      const current = store.getSnapshot();
      if (!stagedPlan || current.reviewPlanId !== stagedPlan.id || acknowledgedReview !== reviewKey)
        throw new Error(
          'Check the currently staged proposal and confirm its measurements before approving.',
        );
      const approved = store.approvePlan(stagedPlan.id);
      setAcknowledgedReview(null);
      setError(null);
      setFeedback(
        `Human approval recorded for ${approved.id}. Its CSV and printable cut sheet are now available for this page session.`,
      );
    } catch (cause) {
      setReviewError(errorMessage(cause));
    }
  }

  function rejectReview() {
    setReviewError(null);
    try {
      const current = store.getSnapshot();
      const revoking =
        current.reviewPlanId !== null && current.reviewPlanId === current.approvedPlanId;
      store.rejectReview();
      setAcknowledgedReview(null);
      setFeedback(
        revoking
          ? `Review closed and the existing approval for ${current.reviewPlanId} revoked. Review and approve a fresh complete plan before release.`
          : 'Proposal rejected without approval. Adjust measurements or choose another objective, then find a new plan.',
      );
    } catch (cause) {
      setReviewError(errorMessage(cause));
    }
  }

  function replaceWorkspace() {
    setConfirmationError(null);
    try {
      if (confirmation === 'sample') store.resetSample();
      else if (confirmation === 'clear') store.clearWorkspace();
      else return;
      setEditorEpoch((epoch) => epoch + 1);
      setFeedback(
        confirmation === 'sample'
          ? 'Illustrative sample loaded. Verify or replace these measurements, then find a cutting plan.'
          : 'Measurements cleared. Add usable stock and the parts you need to begin your next project.',
      );
      setError(null);
      setConfirmation(null);
    } catch (cause) {
      setConfirmationError(errorMessage(cause));
    }
  }

  function downloadApprovedCsv() {
    run(() => {
      requireSavedMeasurements();
      const current = store.getSnapshot();
      if (!current.approvedPlanId)
        throw new Error('A fresh, complete, human-approved plan is required for CSV export.');
      const id = current.approvedPlanId;
      const { filename, csv } = exportApprovedPlan(current, id);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        store.recordExport(id, 'human');
        setFeedback(`Approved CSV prepared as ${filename}. Check your browser's downloads.`);
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    });
  }

  function printApprovedPlan() {
    run(() => {
      requireSavedMeasurements();
      const current = store.getSnapshot();
      const plan = current.plans.find((candidate) => candidate.id === current.approvedPlanId);
      if (!plan || !plan.solution.complete || plan.basedOnRevision !== current.workspace.revision)
        throw new Error(
          'Only a fresh, complete, human-approved plan can be printed. Review and approve the current measurements first.',
        );
      window.print();
      store.recordActivity(
        'human',
        'print_requested',
        `Browser printing requested for approved plan ${plan.id}, revision ${plan.basedOnRevision}. The browser does not report whether a paper copy was printed.`,
      );
      setFeedback(`Printing requested for approved plan ${plan.id}. No stock has been consumed.`);
    });
  }

  async function copyAgentPrompt() {
    setError(null);
    setFeedback(null);
    setCopyFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(AGENT_PROMPT);
      setCopyFeedback(
        'Copied. Paste this prompt into your real browser agent while the workshop is open.',
      );
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
      setCopyFeedback(
        'Clipboard access is unavailable. The prompt is selected; copy it with your keyboard or browser menu.',
      );
    }
  }

  return (
    <>
      <div className="screen-app">
        <a className="skip-link" href="#workbench">
          Skip to workbench
        </a>
        <header className="site-header">
          <a className="wordmark" href="#top" aria-label="Offcut, back to top">
            <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
              <path d="M3 8h22v8H3zM3 20h14v8H3zM21 20h16v8H21zM29 8h8v8h-8z" fill="currentColor" />
            </svg>
            <span>
              offcut<span className="wordmark-dot">.</span>
            </span>
          </a>
          <nav className="bench-nav" aria-label="Workbench sections">
            <a href="#measurements">
              <span>01</span> Measurements
            </a>
            <a href="#cutting-plan">
              <span>02</span> Cutting plan
            </a>
            <a href="#browser-agent">
              <span>03</span> Browser agent
            </a>
          </nav>
          <a
            className={`bridge-status bridge-status--${snapshot.bridge.state}`}
            href="#browser-agent"
          >
            <span className="status-dot" aria-hidden="true" />
            <span>{BRIDGE_LABELS[snapshot.bridge.state]}</span>
          </a>
        </header>
        <div className="page-shell" id="top">
          <section className="intro" aria-labelledby="intro-heading">
            <div>
              <p className="eyebrow">For the lengths already on your rack</p>
              <h1 id="intro-heading">
                Good cuts.
                <br />
                <span>Less guesswork.</span>
              </h1>
            </div>
            <div className="intro-copy">
              <p>
                A cutting-stock workbench for small workshops. Measure your stock, compare real
                arrangements, and make the final call.
              </p>
              <p className="small-text">
                One-dimensional crosscuts. Same material and section. Every millimetre accounted
                for.
              </p>
            </div>
            <div className="intro-art">
              <BenchIllustration />
              <p>Measure twice. Plan here.</p>
            </div>
          </section>

          {snapshot.notice && (
            <aside className="notice storage-notice" role="status">
              <div>
                <span className="eyebrow">A note about this workshop</span>
                <p>{snapshot.notice}</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss workshop notice"
                onClick={() => run(() => store.dismissNotice())}
              >
                <Icon name="close" />
              </button>
            </aside>
          )}
          {error && (
            <div className="notice notice--error global-error" role="alert">
              <div>
                <strong>That action could not be completed.</strong>
                <p>{error}</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError(null)}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          <p
            className={`action-feedback${feedback ? ' action-feedback--visible' : ''}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {feedback}
          </p>

          <main id="workbench" tabIndex={-1}>
            <div className="workbench-grid">
              <section
                id="measurements"
                className="measurement-column"
                aria-labelledby="measurements-heading"
              >
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">01 / Measure</p>
                    <h2 id="measurements-heading">Your side of the bench</h2>
                  </div>
                  <span className="revision-badge">Revision {workspace.revision}</span>
                </div>
                <WorkbenchEditors
                  key={editorEpoch}
                  workspace={workspace}
                  store={store}
                  disabled={solving}
                  onError={showError}
                  onDirtyChange={store.setPendingMeasurements}
                />
                <div className="workspace-management">
                  <div>
                    <button
                      type="button"
                      className="text-button"
                      disabled={solving}
                      onClick={(event) => {
                        confirmationInvoker.current = event.currentTarget;
                        setConfirmationError(null);
                        setConfirmation('sample');
                      }}
                    >
                      Load illustrative sample
                    </button>
                    <button
                      type="button"
                      className="text-button text-button--danger"
                      disabled={solving}
                      onClick={(event) => {
                        confirmationInvoker.current = event.currentTarget;
                        setConfirmationError(null);
                        setConfirmation('clear');
                      }}
                    >
                      Clear measurements
                    </button>
                  </div>
                  <p>
                    The starter example is illustrative. Replace or verify every measurement before
                    using a plan.
                  </p>
                </div>
              </section>

              <section
                id="cutting-plan"
                className="planning-column"
                aria-labelledby="planning-heading"
                aria-busy={solving}
              >
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">02 / Arrange</p>
                    <h2 id="planning-heading">A plan, not a guess</h2>
                  </div>
                  <span className="planning-mark" aria-hidden="true">
                    ↗
                  </span>
                </div>
                <div className="planning-controls">
                  <label className="field" htmlFor="planning-objective">
                    What matters most?
                    <select
                      id="planning-objective"
                      aria-describedby="objective-description"
                      value={objective}
                      disabled={solving}
                      onChange={(event) => setObjective(event.target.value as Objective)}
                    >
                      {(Object.keys(OBJECTIVES) as Objective[]).map((value) => (
                        <option key={value} value={value}>
                          {OBJECTIVES[value].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="objective-description" id="objective-description">
                    {OBJECTIVES[objective].description}
                  </p>
                  <div className="current-constraints">
                    <span>{workspace.settings.kerfMm} mm kerf / part</span>
                    <span>Keep remnants ≥ {formatNumber(workspace.settings.minReusableMm)} mm</span>
                  </div>
                  {protectedStock.length > 0 && (
                    <p className="planner-protection">
                      <Icon name="lock" />
                      {protectedStock.length} protected{' '}
                      {protectedStock.length === 1 ? 'length is' : 'lengths are'} excluded from
                      every objective.
                    </p>
                  )}
                  <button
                    type="button"
                    id="find-cutting-plan"
                    className="button button--primary button--full"
                    disabled={solving || pendingMeasurements || workspace.requirements.length === 0}
                    onClick={findPlan}
                  >
                    <span>{solving ? 'Finding a cutting plan…' : 'Find a cutting plan'}</span>
                    {solving ? (
                      <span className="working-indicator" aria-hidden="true" />
                    ) : (
                      <Icon name="arrow" />
                    )}
                  </button>
                  {pendingMeasurements && (
                    <p className="pending-note" role="status">
                      Save or cancel your field edits, and add or cancel any new row, before solving
                      or releasing a cut sheet.
                    </p>
                  )}
                  {workspace.requirements.length === 0 ? (
                    <p className="field-hint">Add at least one part to the cut list to begin.</p>
                  ) : availableStockCount === 0 ? (
                    <p className="pending-note">
                      {workspace.stock.length === 0
                        ? 'There is no stock yet.'
                        : 'All stock is protected.'}{' '}
                      Add usable stock or deliberately release a length. Solving now can only return
                      an incomplete proposal.
                    </p>
                  ) : (
                    <p className="field-hint">
                      {requestedParts} parts · {availableStockCount} available lengths. Choose
                      another objective and solve again to compare real proposals.
                    </p>
                  )}
                </div>

                <PlanComparison
                  plans={snapshot.plans}
                  revision={workspace.revision}
                  protectedStockIds={protectedStockIds}
                  selectedId={snapshot.selectedPlanId}
                  approvedId={snapshot.approvedPlanId}
                  reviewId={snapshot.reviewPlanId}
                  onSelect={selectPlan}
                />

                {selectedPlan ? (
                  <div
                    ref={selectedProposalRef}
                    className="selected-proposal"
                    aria-labelledby="selected-plan-heading"
                  >
                    <div className="proposal-heading">
                      <p className="eyebrow">Selected proposal</p>
                      <h3 id="selected-plan-heading">
                        {OBJECTIVES[selectedPlan.solution.objective].label}
                      </h3>
                      <p className="proposal-attribution">
                        <PlanReference id={selectedPlan.id} />
                        <span>
                          Proposed by {ACTOR_LABELS[selectedPlan.actor]} · revision{' '}
                          {selectedPlan.basedOnRevision}
                        </span>
                        <time dateTime={selectedPlan.createdAt}>
                          {formatPlanDateTime(selectedPlan.createdAt)}
                        </time>
                      </p>
                      <p className="field-hint" role="status">
                        {approvedPlan?.id === selectedPlan.id
                          ? pendingMeasurements
                            ? 'Approved saved plan; finish or cancel your edits before release.'
                            : 'This exact saved plan is approved for this page session.'
                          : 'This selected proposal is not approved.'}
                      </p>
                    </div>
                    <CuttingPlan plan={selectedPlan} workspace={workspace} palette={palette} />
                    <div className="review-action">
                      <button
                        type="button"
                        className="button button--full"
                        disabled={
                          solving ||
                          pendingMeasurements ||
                          !selectedPlan.solution.complete ||
                          selectedPlan.basedOnRevision !== workspace.revision
                        }
                        onClick={stageSelectedPlan}
                      >
                        <span>Review this plan</span>
                        <Icon name="arrow" />
                      </button>
                      <p>
                        {selectedPlan.basedOnRevision !== workspace.revision
                          ? 'Find a fresh plan for the current revision before review.'
                          : !selectedPlan.solution.complete
                            ? 'A complete plan is required. Resolve the missing parts, then solve again.'
                            : pendingMeasurements
                              ? 'Finish or cancel your measurement edits before requesting review of the saved plan.'
                              : 'Review and approve here. Registered WebMCP tools cannot approve a proposal.'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="unplanned-state">
                    <div className="unplanned-rack" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                      <i />
                    </div>
                    <p className="eyebrow">The next cut starts with a plan</p>
                    <h3>
                      Let the lengths
                      <br />
                      find their place.
                    </h3>
                    <p>
                      {workspace.requirements.length === 0
                        ? 'Record the parts you need on your side of the bench. Your first real proposal will appear here.'
                        : 'Your measurements are ready for a real calculation. Choose an objective above and find a cutting plan.'}
                    </p>
                    <p className="field-hint">
                      No plan is pre-computed, no stock is consumed, and nothing is approved
                      automatically.
                    </p>
                  </div>
                )}

                <section
                  className={`release-panel${approvedPlan ? ' release-panel--approved' : ''}`}
                  aria-labelledby="release-heading"
                >
                  <div className="release-heading">
                    <Icon name={approvedPlan ? 'check' : 'lock'} />
                    <div>
                      <p className="eyebrow">03 / Human release</p>
                      <h3 id="release-heading">
                        {approvedPlan
                          ? 'Your cut sheet is approved'
                          : 'A final call that stays yours'}
                      </h3>
                    </div>
                  </div>
                  {approvedPlan ? (
                    <>
                      <p>
                        Approved plan <PlanReference id={approvedPlan.id} /> · revision{' '}
                        {approvedPlan.basedOnRevision}.
                      </p>
                      {selectedPlan && selectedPlan.id !== approvedPlan.id && (
                        <p className="release-difference">
                          A different proposal is selected above. Download and print always use this
                          approved plan, not the selected draft.
                        </p>
                      )}
                      {pendingMeasurements && (
                        <p className="notice notice--warning" role="status">
                          <strong>Release paused; the saved plan is still approved.</strong> Finish
                          or cancel your edits before downloading or printing. Saving changed
                          measurements requires a fresh plan and approval.
                        </p>
                      )}
                    </>
                  ) : (
                    <p>
                      Review a fresh, complete proposal and approve it yourself to unlock CSV and
                      print. Saving changed measurements invalidates its release.
                    </p>
                  )}
                  <div className="release-buttons">
                    <button
                      type="button"
                      className="button button--small"
                      disabled={!approvedPlan || pendingMeasurements || solving}
                      onClick={downloadApprovedCsv}
                    >
                      <Icon name="download" />
                      Download approved CSV
                    </button>
                    <button
                      type="button"
                      className="button button--small button--secondary"
                      disabled={!approvedPlan || pendingMeasurements || solving}
                      onClick={printApprovedPlan}
                    >
                      <Icon name="print" />
                      Print approved cut sheet
                    </button>
                  </div>
                  {approvedPlan && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        run(() => {
                          store.revokeApproval();
                          setFeedback(
                            'Approval revoked. CSV and print are locked until a fresh complete plan receives human approval again.',
                          );
                        })
                      }
                    >
                      Revoke approval
                    </button>
                  )}
                  <p className="field-hint">
                    Approval lasts only in this page session. It approves a plan; it does not cut or
                    consume stock.
                  </p>
                </section>
              </section>
            </div>

            <section
              id="browser-agent"
              className="collaboration"
              aria-labelledby="collaboration-heading"
            >
              <div className="collaboration-heading">
                <div>
                  <p className="eyebrow">One bench. Two ways to work.</p>
                  <h2 id="collaboration-heading">
                    An agent can arrange.
                    <br />
                    Only you can approve.
                  </h2>
                </div>
                <div
                  className={`native-state native-state--${snapshot.bridge.state}`}
                  role="status"
                >
                  <div>
                    <span className="status-dot" aria-hidden="true" />
                    <strong>{BRIDGE_LABELS[snapshot.bridge.state]}</strong>
                  </div>
                  <p>{snapshot.bridge.message}</p>
                  <p className="native-provider">
                    {snapshot.bridge.registeredTools} tools registered ·{' '}
                    {snapshot.bridge.provider
                      ? `${snapshot.bridge.provider}.modelContext`
                      : 'Native provider not reported'}
                  </p>
                </div>
              </div>
              <div className="collaboration-grid">
                <div className="agent-handoff">
                  <p>
                    There is no built-in chat or simulated agent here. Offcut has no backend, does
                    not call a model and needs no API key. Your real browser agent lives outside
                    this website. When you ask it to, it can read your measurements through native
                    WebMCP under its provider's terms.
                  </p>
                  <label htmlFor="browser-agent-prompt" className="prompt-label">
                    A real prompt for your browser agent
                  </label>
                  <textarea
                    id="browser-agent-prompt"
                    ref={promptRef}
                    readOnly
                    value={AGENT_PROMPT}
                    rows={6}
                  />
                  <button
                    type="button"
                    className="button button--paper button--small"
                    aria-describedby="prompt-copy-status"
                    onClick={copyAgentPrompt}
                  >
                    <Icon name="copy" />
                    Copy browser-agent prompt
                  </button>
                  <p
                    id="prompt-copy-status"
                    className="copy-feedback"
                    role="status"
                    aria-live="polite"
                  >
                    {copyFeedback}
                  </p>
                  <details className="native-instructions">
                    <summary>Native browser setup & tool contracts</summary>
                    <p>
                      For native testing, launch a compatible browser with{' '}
                      <code>--enable-features=WebMCP</code> and use a real browser-agent host. The
                      flag alone does not connect an agent. Standard browsers retain the complete
                      manual workbench.
                    </p>
                    <p>
                      These are the website's tool contracts, not a simulated chat or a promise that
                      an agent is connected:
                    </p>
                    <ul>
                      {TOOL_NAMES.map((name) => (
                        <li key={name}>
                          <code>{name}</code>
                        </li>
                      ))}
                    </ul>
                    <p>
                      Tools inspect, solve, compare and stage proposals. Export requires a fresh
                      human-approved plan. There is no approval tool, and protected stock cannot be
                      released by a tool.
                    </p>
                  </details>
                </div>
                <section className="activity-panel" aria-labelledby="activity-heading">
                  <div className="activity-heading">
                    <h3 id="activity-heading">Marks left on the bench</h3>
                    <span>
                      {snapshot.events.length} / {LIMITS.activityEvents} session events
                    </span>
                  </div>
                  <p className="activity-intro">
                    Actual actions, attributed to their source. “WebMCP” means a real native tool
                    call—not a claimed connection to a particular model.
                  </p>
                  {activity.length > 0 ? (
                    <ol
                      className="activity-list"
                      tabIndex={0}
                      aria-label="Recorded workshop activity"
                    >
                      {activity.map((event) => (
                        <li
                          key={event.id}
                          className={`activity-event activity-event--${event.actor}`}
                        >
                          <div className="event-meta">
                            <span className="actor-label">{ACTOR_LABELS[event.actor]}</span>
                            <span className="event-action">
                              {event.action.replaceAll('_', ' ')}
                            </span>
                            <time dateTime={event.at}>
                              {activityTimeFormatter.format(new Date(event.at))}
                            </time>
                          </div>
                          <p>{event.detail}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="activity-empty">
                      <p>No actions recorded in this page session.</p>
                      <span>
                        Measurement edits, real plans, human reviews and actual WebMCP calls appear
                        here as they happen.
                      </span>
                    </div>
                  )}
                </section>
              </div>
            </section>
          </main>
          <footer className="site-footer">
            <div>
              <strong>Local measurements. Session-only approval.</strong>
              <p>
                Validated project measurements and settings are saved on this device in this browser
                when storage is available. Plans, activity and approvals last only for this page
                session. Storage problems appear in the workshop notice. Your browser agent has its
                own data policy.
              </p>
            </div>
            <div>
              <strong>Take the plan to the bench, not on trust.</strong>
              <p>
                Offcut is a planning estimate, not machine-control or a safe-cutting guarantee.
                Verify stock identity, usable lengths, kerf, workholding and quantities before
                cutting. All starter sample data are illustrative.
              </p>
              <p>
                <a href="./guide.html" target="_blank" rel="noopener">
                  How to use & run Offcut
                </a>
              </p>
            </div>
            <span className="footer-wordmark" aria-hidden="true">
              offcut.
            </span>
          </footer>
        </div>
      </div>

      <PrintableCutSheet
        plan={approvedPlan}
        workspace={workspace}
        palette={palette}
        pendingMeasurements={pendingMeasurements}
      />

      <Dialog
        open={confirmation !== null && stagedPlan === null}
        compact
        onDismiss={() => setConfirmation(null)}
        labelledBy="confirmation-heading"
        describedBy="confirmation-description"
        returnFocusTo={confirmationInvoker.current}
      >
        <div className="dialog-header">
          <p className="eyebrow">Replace measurements</p>
          <h2 id="confirmation-heading">
            {confirmation === 'sample'
              ? 'Start from the illustrative sample?'
              : 'Clear this workshop?'}
          </h2>
        </div>
        <div className="dialog-body">
          <p id="confirmation-description">
            {confirmation === 'sample'
              ? 'This replaces your project, stock, parts and physical settings with illustrative example measurements.'
              : 'This removes your stock and cut requirements and resets the project and physical settings.'}{' '}
            Unsaved field edits, retained proposals and any page-session approval will also be
            cleared. This cannot be undone here.
          </p>
          {confirmationError && (
            <p className="notice notice--error" role="alert">
              {confirmationError}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button button--secondary"
            data-dialog-focus
            onClick={() => setConfirmation(null)}
          >
            Keep my measurements
          </button>
          <button
            type="button"
            className={`button${confirmation === 'clear' ? ' button--danger' : ''}`}
            data-testid="confirm-replace-measurements"
            aria-label={confirmation === 'clear' ? 'Confirm clear measurements' : undefined}
            onClick={replaceWorkspace}
          >
            {confirmation === 'sample' ? 'Replace with sample' : 'Clear measurements'}
          </button>
        </div>
      </Dialog>

      <Dialog
        open={stagedPlan !== null}
        focusKey={stagedPlan?.id}
        onDismiss={rejectReview}
        labelledBy="review-heading"
        describedBy="review-description"
      >
        <div className="dialog-header review-header">
          <div>
            <p className="eyebrow">A human decision / not an agent permission</p>
            <h2 id="review-heading" tabIndex={-1} data-dialog-focus>
              Review before the first cut.
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={
              reviewRevokesApproval
                ? 'Close review and revoke existing approval'
                : 'Close review without approval'
            }
            onClick={rejectReview}
          >
            <Icon name="close" />
          </button>
        </div>
        {stagedPlan && (
          <>
            <div className="dialog-body review-body">
              <p id="review-description">
                Check stock identity, usable lengths, part quantities, kerf and protected stock.
                Approval is for this page session; it does not cut or consume material.
              </p>
              <div className="review-project">
                <h3>{workspace.title}</h3>
                <p>{workspace.material}</p>
                <p
                  className="proposal-attribution"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <PlanReference id={stagedPlan.id} />
                  <span>
                    {OBJECTIVES[stagedPlan.solution.objective].label} · proposed by{' '}
                    {ACTOR_LABELS[stagedPlan.actor]} · revision {stagedPlan.basedOnRevision}
                  </span>
                </p>
                <p className="review-constraints">
                  {workspace.settings.kerfMm} mm kerf per part · reusable positive remnants ≥{' '}
                  {formatNumber(workspace.settings.minReusableMm)} mm
                </p>
                <dl className="review-stock" aria-label="Stock identities for this review">
                  <div>
                    <dt>Using</dt>
                    <dd>
                      {stagedPlan.solution.layouts.map((layout) => (
                        <span
                          key={layout.stockId}
                          className="reference"
                          title={`${layout.stockLabel} · ${formatNumber(layout.stockLengthMm)} mm usable`}
                        >
                          {layout.stockId}
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <Icon name="lock" />
                      {stagedPlan.basedOnRevision === workspace.revision
                        ? 'Protected'
                        : 'Currently protected'}
                    </dt>
                    <dd>
                      {protectedStock.length > 0
                        ? protectedStock.map((board) => (
                            <span
                              key={board.id}
                              className="reference"
                              title={`${board.label} · ${formatNumber(board.lengthMm)} mm usable`}
                            >
                              {board.id}
                            </span>
                          ))
                        : 'None'}
                    </dd>
                  </div>
                </dl>
              </div>
              {pendingMeasurements && (
                <div className="notice notice--warning">
                  <strong>Unfinished measurement edits are not in this proposal.</strong>
                  <p>
                    Reject this review, then save or cancel the edits before requesting a fresh
                    review.
                  </p>
                </div>
              )}
              <CuttingPlan plan={stagedPlan} workspace={workspace} palette={palette} />
              {approvedPlan && approvedPlan.id !== stagedPlan.id && (
                <p className="notice notice--warning">
                  <span>
                    Approving this proposal will replace the current approval for{' '}
                    <PlanReference id={approvedPlan.id} />.
                  </span>
                </p>
              )}
              {reviewRevokesApproval && (
                <p className="notice notice--warning">
                  This exact saved plan is already approved. Closing, rejecting or pressing Escape
                  in this re-review revokes its existing approval. Approve the checked sheet again
                  to keep it released.
                </p>
              )}
            </div>
            <div className="review-decision">
              <label className="checkbox-label" htmlFor="review-acknowledgement">
                <input
                  id="review-acknowledgement"
                  type="checkbox"
                  checked={acknowledgedReview === reviewKey}
                  disabled={!reviewEligible}
                  onChange={(event) =>
                    setAcknowledgedReview(event.target.checked ? reviewKey : null)
                  }
                />
                <span>
                  I checked the usable lengths, kerf and part quantities against my measurements.
                </span>
              </label>
              {reviewError && (
                <p className="field-error" role="alert">
                  {reviewError}
                </p>
              )}
              <div className="dialog-actions">
                <button type="button" className="button button--secondary" onClick={rejectReview}>
                  {reviewRevokesApproval ? 'Reject and revoke approval' : 'Reject proposal'}
                </button>
                <button
                  type="button"
                  className="button"
                  id="approve-cut-sheet"
                  disabled={!reviewEligible || acknowledgedReview !== reviewKey}
                  onClick={approveReviewedPlan}
                >
                  <Icon name="check" />
                  Approve cut sheet
                </button>
              </div>
              <p className="field-hint">
                This review action approves only the staged proposal. Saving changed measurements or
                reloading the page invalidates approval.
              </p>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
