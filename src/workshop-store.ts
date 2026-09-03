import { WorkshopError, errorMessage } from './errors';
import { solveCutPlan, validateWorkspace } from './planner';
import { createEmptyWorkspace, createSampleWorkspace } from './sample';
import { LIMITS, OBJECTIVES } from './types';
import type {
  ActivityEvent,
  Actor,
  BridgeState,
  Objective,
  PlanRecord,
  PlanSolution,
  WorkshopSnapshot,
  WorkshopStore,
  Workspace,
} from './types';

const STORAGE_KEY = 'offcut.measurements.v1';
const STORAGE_VERSION = 1;
const SESSION_NOTICE = 'Plans and approvals last only for this page session.';
const SAMPLE_NOTICE = `Illustrative sample measurements are loaded. Replace them with your actual usable stock and cut list. ${SESSION_NOTICE}`;
const SAVED_MEASUREMENT_FIELDS = ['version', 'workspace'] as const;
const MEASUREMENT_FIELDS = ['title', 'material', 'stock', 'requirements', 'settings'] as const;
const PROJECT_FIELDS = ['title', 'material'] as const;
const STOCK_FIELDS = ['id', 'label', 'lengthMm', 'kind', 'locked'] as const;
const STOCK_INPUT_FIELDS = ['label', 'lengthMm', 'kind', 'locked'] as const;
const REQUIREMENT_FIELDS = ['id', 'label', 'lengthMm', 'quantity'] as const;
const REQUIREMENT_INPUT_FIELDS = ['label', 'lengthMm', 'quantity'] as const;
const SETTINGS_FIELDS = ['kerfMm', 'minReusableMm'] as const;
const PLAN_REQUEST_FIELDS = ['expectedRevision', 'objective', 'excludedStockIds'] as const;
const SOLUTION_FIELDS = [
  'objective',
  'layouts',
  'metrics',
  'complete',
  'unfulfilled',
  'excludedStockIds',
  'search',
] as const;
const SEARCH_FIELDS = ['method', 'provenOptimal', 'nodes', 'limit'] as const;
const LAYOUT_FIELDS = [
  'stockId',
  'stockLabel',
  'stockKind',
  'stockLengthMm',
  'cuts',
  'kerfMm',
  'remnantMm',
  'remnantKind',
] as const;
const CUT_FIELDS = ['requirementId', 'label', 'instance', 'lengthMm', 'offsetMm'] as const;
const UNFULFILLED_FIELDS = ['requirementId', 'label', 'quantity', 'reason'] as const;
const METRIC_FIELDS = [
  'stockUsedMm',
  'partsMm',
  'kerfMm',
  'reusableMm',
  'scrapMm',
  'boardCount',
  'utilization',
] as const;
const BRIDGE_FIELDS = ['state', 'provider', 'registeredTools', 'message'] as const;
const BRIDGE_STATES: readonly BridgeState['state'][] = [
  'checking',
  'ready',
  'unsupported',
  'error',
];
const deeplyFrozen = new WeakSet<object>();

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !deeplyFrozen.has(value)) {
    deeplyFrozen.add(value);
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function assertFields(
  value: unknown,
  fields: readonly string[],
  name: string,
  requireAll = false,
  code = 'INVALID_INPUT',
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkshopError(code, `${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkshopError(code, `${name} must contain plain data properties.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) {
      throw new WorkshopError(code, `${name} contains an unsupported field: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new WorkshopError(code, `${name}.${key} must be an ordinary data property.`);
    }
  }
  if (requireAll) {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        throw new WorkshopError(code, `${name}.${field} is required.`);
      }
    }
  }
}

function assertActor(actor: Actor): void {
  if (actor !== 'human' && actor !== 'webmcp' && actor !== 'system') {
    throw new WorkshopError('INVALID_INPUT', 'Activity actor must be human, webmcp, or system.');
  }
}

function sameMeasurements(left: Workspace, right: Workspace): boolean {
  return (
    left.title === right.title &&
    left.material === right.material &&
    left.settings.kerfMm === right.settings.kerfMm &&
    left.settings.minReusableMm === right.settings.minReusableMm &&
    left.stock.length === right.stock.length &&
    left.stock.every((board, index) => {
      const other = right.stock[index]!;
      return (
        board.id === other.id &&
        board.label === other.label &&
        board.lengthMm === other.lengthMm &&
        board.kind === other.kind &&
        board.locked === other.locked
      );
    }) &&
    left.requirements.length === right.requirements.length &&
    left.requirements.every((part, index) => {
      const other = right.requirements[index]!;
      return (
        part.id === other.id &&
        part.label === other.label &&
        part.lengthMm === other.lengthMm &&
        part.quantity === other.quantity
      );
    })
  );
}

function restoreMeasurements(serialized: string): Workspace {
  const envelope: unknown = JSON.parse(serialized);
  assertFields(
    envelope,
    SAVED_MEASUREMENT_FIELDS,
    'Saved measurements',
    true,
    'INVALID_SAVED_DATA',
  );
  if (envelope.version !== STORAGE_VERSION) {
    throw new WorkshopError(
      'UNSUPPORTED_STORAGE_VERSION',
      'The saved measurements use an unsupported storage version.',
    );
  }
  const measurements = envelope.workspace;
  assertFields(measurements, MEASUREMENT_FIELDS, 'Saved workspace', true, 'INVALID_SAVED_DATA');
  if (!Array.isArray(measurements.stock) || !Array.isArray(measurements.requirements)) {
    throw new WorkshopError(
      'INVALID_SAVED_DATA',
      'Saved stock and cut requirements must be arrays.',
    );
  }
  if (measurements.stock.length > LIMITS.stockBoards) {
    throw new WorkshopError(
      'INVALID_SAVED_DATA',
      `Saved stock must contain at most ${LIMITS.stockBoards} boards.`,
    );
  }
  if (measurements.requirements.length > LIMITS.requirements) {
    throw new WorkshopError(
      'INVALID_SAVED_DATA',
      `Saved requirements must contain at most ${LIMITS.requirements} distinct entries.`,
    );
  }
  for (const board of measurements.stock) {
    assertFields(board, STOCK_FIELDS, 'Saved stock board', true, 'INVALID_SAVED_DATA');
  }
  for (const part of measurements.requirements) {
    assertFields(part, REQUIREMENT_FIELDS, 'Saved cut requirement', true, 'INVALID_SAVED_DATA');
  }
  assertFields(
    measurements.settings,
    SETTINGS_FIELDS,
    'Saved planner settings',
    true,
    'INVALID_SAVED_DATA',
  );
  const workspace = { ...measurements, revision: 0 } as unknown as Workspace;
  validateWorkspace(workspace);
  return workspace;
}

/** Independently check the returned physical plan, without trusting solver metrics. */
function validateSolution(
  workspace: Workspace,
  solution: PlanSolution,
  expectedObjective?: Objective,
  expectedExclusions?: readonly string[],
): void {
  assertFields(solution, SOLUTION_FIELDS, 'Plan solution', true, 'INVALID_PLAN');
  if (
    !Object.prototype.hasOwnProperty.call(OBJECTIVES, solution.objective) ||
    (expectedObjective !== undefined && solution.objective !== expectedObjective)
  ) {
    throw new WorkshopError(
      'INVALID_PLAN',
      'The plan objective does not match a supported requested objective.',
    );
  }
  if (
    typeof solution.complete !== 'boolean' ||
    !Array.isArray(solution.layouts) ||
    !Array.isArray(solution.unfulfilled) ||
    !Array.isArray(solution.excludedStockIds)
  ) {
    throw new WorkshopError(
      'INVALID_PLAN',
      'The plan must contain layouts, quantity accounting, and explicit exclusions.',
    );
  }
  if (workspace.requirements.length === 0 || solution.layouts.length > workspace.stock.length) {
    throw new WorkshopError(
      'INVALID_PLAN',
      'The plan does not match the current stock and cut requirements.',
    );
  }
  assertFields(solution.search, SEARCH_FIELDS, 'Plan search', true, 'INVALID_PLAN');
  if (
    solution.search.method !== 'branch-and-bound' ||
    typeof solution.search.provenOptimal !== 'boolean' ||
    !Number.isSafeInteger(solution.search.nodes) ||
    solution.search.nodes < 0 ||
    solution.search.limit !== LIMITS.searchNodes ||
    solution.search.nodes > solution.search.limit ||
    (solution.search.provenOptimal && !solution.complete)
  ) {
    throw new WorkshopError(
      'INVALID_PLAN',
      'The plan search accounting is invalid. An incomplete plan cannot be proven optimal.',
    );
  }

  const stock = new Map(workspace.stock.map((board) => [board.id, board] as const));
  const requirements = new Map(workspace.requirements.map((part) => [part.id, part] as const));
  const excluded = new Set<string>();
  for (const id of solution.excludedStockIds) {
    if (typeof id !== 'string' || !stock.has(id) || excluded.has(id)) {
      throw new WorkshopError(
        'INVALID_PLAN',
        'Plan exclusions must name distinct existing stock boards.',
      );
    }
    excluded.add(id);
  }
  if (expectedExclusions !== undefined) {
    const requested = new Set(expectedExclusions);
    if (requested.size !== excluded.size || [...requested].some((id) => !excluded.has(id))) {
      throw new WorkshopError(
        'INVALID_PLAN',
        'The plan did not preserve the requested additional stock exclusions.',
      );
    }
  }

  const usedStock = new Set<string>();
  const produced = new Map(
    workspace.requirements.map((part) => [part.id, new Set<number>()] as const),
  );
  let stockUsedMm = 0;
  let partsMm = 0;
  let kerfMm = 0;
  let reusableMm = 0;
  let scrapMm = 0;
  for (const layout of solution.layouts) {
    assertFields(layout, LAYOUT_FIELDS, 'Board layout', true, 'INVALID_PLAN');
    const board = stock.get(layout.stockId);
    if (!board || usedStock.has(layout.stockId)) {
      throw new WorkshopError(
        'INVALID_PLAN',
        'Each layout must use a different existing stock board.',
      );
    }
    if (board.locked || excluded.has(board.id)) {
      throw new WorkshopError(
        'INVALID_PLAN',
        `The plan touches protected or excluded stock ${board.id}.`,
      );
    }
    if (
      layout.stockLabel !== board.label ||
      layout.stockKind !== board.kind ||
      layout.stockLengthMm !== board.lengthMm
    ) {
      throw new WorkshopError(
        'INVALID_PLAN',
        `The layout identity and measurements do not match stock ${board.id}.`,
      );
    }
    if (
      !Array.isArray(layout.cuts) ||
      layout.cuts.length === 0 ||
      layout.cuts.length > LIMITS.totalParts
    ) {
      throw new WorkshopError(
        'INVALID_PLAN',
        `Stock ${board.id} must contain a nonempty, bounded cut layout.`,
      );
    }
    usedStock.add(board.id);
    let offsetMm = 0;
    let boardPartsMm = 0;
    for (const cut of layout.cuts) {
      assertFields(cut, CUT_FIELDS, 'Planned cut', true, 'INVALID_PLAN');
      const requirement = requirements.get(cut.requirementId);
      if (
        !requirement ||
        cut.label !== requirement.label ||
        cut.lengthMm !== requirement.lengthMm
      ) {
        throw new WorkshopError(
          'INVALID_PLAN',
          'A planned cut does not match a current requirement identity, label, or length.',
        );
      }
      const instances = produced.get(requirement.id)!;
      if (
        !Number.isSafeInteger(cut.instance) ||
        cut.instance < 1 ||
        cut.instance > requirement.quantity ||
        instances.has(cut.instance)
      ) {
        throw new WorkshopError(
          'INVALID_PLAN',
          `Cut instances for ${requirement.id} must be unique and within the requested quantity.`,
        );
      }
      if (cut.offsetMm !== offsetMm) {
        throw new WorkshopError(
          'INVALID_PLAN',
          `Cut offsets on ${board.id} must include every preceding part and saw kerf.`,
        );
      }
      instances.add(cut.instance);
      boardPartsMm += cut.lengthMm;
      offsetMm += cut.lengthMm + workspace.settings.kerfMm;
      if (offsetMm > board.lengthMm) {
        throw new WorkshopError(
          'INVALID_PLAN',
          `The cuts and one saw pass per part exceed usable stock ${board.id}.`,
        );
      }
    }
    const boardKerfMm = layout.cuts.length * workspace.settings.kerfMm;
    const remnantMm = board.lengthMm - offsetMm;
    const remnantKind =
      remnantMm === 0
        ? 'none'
        : remnantMm >= workspace.settings.minReusableMm
          ? 'reusable'
          : 'scrap';
    if (
      layout.kerfMm !== boardKerfMm ||
      layout.remnantMm !== remnantMm ||
      layout.remnantKind !== remnantKind ||
      board.lengthMm !== boardPartsMm + boardKerfMm + remnantMm
    ) {
      throw new WorkshopError(
        'INVALID_PLAN',
        `Stock ${board.id} fails saw-kerf, remnant classification, or material-balance checks.`,
      );
    }
    stockUsedMm += board.lengthMm;
    partsMm += boardPartsMm;
    kerfMm += boardKerfMm;
    if (remnantKind === 'reusable') reusableMm += remnantMm;
    if (remnantKind === 'scrap') scrapMm += remnantMm;
  }

  const missing = new Map<string, number>();
  for (const requirement of workspace.requirements) {
    const instances = produced.get(requirement.id)!;
    for (let instance = 1; instance <= instances.size; instance++) {
      if (!instances.has(instance)) {
        throw new WorkshopError(
          'INVALID_PLAN',
          `Produced instances for ${requirement.id} must be numbered from 1 without gaps.`,
        );
      }
    }
    if (instances.size < requirement.quantity)
      missing.set(requirement.id, requirement.quantity - instances.size);
  }
  if (solution.complete !== (missing.size === 0) || solution.unfulfilled.length !== missing.size) {
    throw new WorkshopError(
      'INVALID_PLAN',
      'Plan completeness and unfulfilled quantities do not match the cuts actually laid out.',
    );
  }
  const accounted = new Set<string>();
  for (const unfulfilled of solution.unfulfilled) {
    assertFields(unfulfilled, UNFULFILLED_FIELDS, 'Unfulfilled requirement', true, 'INVALID_PLAN');
    const requirement = requirements.get(unfulfilled.requirementId);
    if (
      !requirement ||
      accounted.has(requirement.id) ||
      !missing.has(requirement.id) ||
      unfulfilled.label !== requirement.label ||
      unfulfilled.quantity !== missing.get(requirement.id) ||
      typeof unfulfilled.reason !== 'string' ||
      unfulfilled.reason.trim().length === 0
    ) {
      throw new WorkshopError(
        'INVALID_PLAN',
        'Every missing requirement must have its exact remaining quantity and a reason.',
      );
    }
    accounted.add(requirement.id);
  }

  assertFields(solution.metrics, METRIC_FIELDS, 'Plan metrics', true, 'INVALID_PLAN');
  const metrics = solution.metrics;
  if (
    metrics.stockUsedMm !== stockUsedMm ||
    metrics.partsMm !== partsMm ||
    metrics.kerfMm !== kerfMm ||
    metrics.reusableMm !== reusableMm ||
    metrics.scrapMm !== scrapMm ||
    metrics.boardCount !== usedStock.size ||
    metrics.utilization !== (stockUsedMm === 0 ? 0 : partsMm / stockUsedMm) ||
    stockUsedMm !== partsMm + kerfMm + reusableMm + scrapMm
  ) {
    throw new WorkshopError(
      'INVALID_PLAN',
      'Plan metrics must exactly match its cuts, kerf, reusable remnants, scrap, and total stock.',
    );
  }
}

export function createWorkshopStore(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
): WorkshopStore {
  const sessionId = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36);
  let sequence = 0;
  const subscriptions = new Set<{ listener: () => void }>();
  let persistence: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null;
  let sessionOnlyNotice: string | null = null;
  let restorationFailed = false;
  let savingFailed = false;

  function nextId(prefix: string): string {
    return `${prefix}-${sessionId}-${++sequence}`;
  }

  function event(actor: Actor, action: string, detail: string): ActivityEvent {
    return { id: nextId('event'), at: new Date().toISOString(), actor, action, detail };
  }

  function appendEvents(existing: ActivityEvent[], ...added: ActivityEvent[]): ActivityEvent[] {
    return existing
      .slice(Math.max(0, existing.length + added.length - LIMITS.activityEvents))
      .concat(added);
  }

  const startupEvents: ActivityEvent[] = [];
  if (storage === null) {
    sessionOnlyNotice = `Local saving is disabled for this workspace; measurements remain in this page only. ${SESSION_NOTICE}`;
  } else if (storage !== undefined) {
    persistence = storage;
  } else if (typeof window === 'undefined') {
    sessionOnlyNotice = `Local browser storage is unavailable; measurements remain in this page only. ${SESSION_NOTICE}`;
  } else {
    try {
      persistence = window.localStorage ?? null;
      if (!persistence) {
        sessionOnlyNotice = `Local browser storage is unavailable; measurements remain in this page only. ${SESSION_NOTICE}`;
      }
    } catch (error) {
      sessionOnlyNotice = `Local browser storage could not be accessed: ${errorMessage(error)}. Measurements remain in this page only. ${SESSION_NOTICE}`;
    }
  }
  if (sessionOnlyNotice !== null) {
    startupEvents.push(event('system', 'Local saving unavailable', sessionOnlyNotice));
  }

  let workspace = createSampleWorkspace();
  let notice: string | null =
    sessionOnlyNotice === null ? SAMPLE_NOTICE : `${SAMPLE_NOTICE} ${sessionOnlyNotice}`;
  let sampleLoaded = true;
  if (persistence !== null) {
    let saved: string | null = null;
    let readSucceeded = false;
    try {
      saved = persistence.getItem(STORAGE_KEY);
      readSucceeded = true;
    } catch (error) {
      restorationFailed = true;
      notice = `Saved measurements could not be read: ${errorMessage(error)}. They were not loaded; the illustrative sample is shown instead. New edits will attempt to save new measurements. ${SESSION_NOTICE}`;
      startupEvents.push(event('system', 'Saved measurements unreadable', notice));
    }
    if (readSucceeded && saved !== null) {
      try {
        workspace = restoreMeasurements(saved);
        sampleLoaded = false;
        notice = `Saved measurements were loaded from this device. No plans, approvals, or agent history were restored. ${SESSION_NOTICE}`;
        startupEvents.push(
          event(
            'system',
            'Saved measurements loaded',
            'Restored validated project measurements and settings only.',
          ),
        );
      } catch (error) {
        restorationFailed = true;
        notice = `Saved measurements were rejected: ${errorMessage(error)}. They were not loaded; the illustrative sample is shown instead. The rejected saved data is unchanged until you edit or reset this workspace. ${SESSION_NOTICE}`;
        startupEvents.push(event('system', 'Saved measurements rejected', notice));
      }
    }
  }
  validateWorkspace(workspace);
  if (sampleLoaded) {
    startupEvents.push(
      event(
        'system',
        'Illustrative sample loaded',
        'Loaded the original sample measurements, not a real workshop or a previously cut job.',
      ),
    );
  }

  let snapshot: WorkshopSnapshot = freezeTree({
    workspace,
    pendingMeasurements: false,
    plans: [],
    selectedPlanId: null,
    reviewPlanId: null,
    approvedPlanId: null,
    events: startupEvents,
    bridge: {
      state: 'checking',
      provider: null,
      registeredTools: 0,
      message: 'Checking for native WebMCP support. Manual workshop planning remains available.',
    },
    notice,
  });

  function publish(next: WorkshopSnapshot): void {
    snapshot = freezeTree(next);
    for (const subscription of [...subscriptions]) {
      if (!subscriptions.has(subscription)) continue;
      try {
        subscription.listener();
      } catch (error) {
        // A broken subscriber must not prevent the others from receiving committed state.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  function assertRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new WorkshopError(
        'INVALID_INPUT',
        'Expected revision must be a nonnegative safe integer.',
      );
    }
    if (expectedRevision !== snapshot.workspace.revision) {
      throw new WorkshopError(
        'REVISION_CONFLICT',
        `Workspace revision ${expectedRevision} is no longer current; read revision ${snapshot.workspace.revision} and try again.`,
        {
          expectedRevision,
          currentRevision: snapshot.workspace.revision,
        },
      );
    }
  }

  function saveMeasurements(
    current: Workspace,
  ): { notice: string; activity?: ActivityEvent } | null {
    if (persistence === null) return { notice: sessionOnlyNotice! };
    const measurements = {
      title: current.title,
      material: current.material,
      stock: current.stock,
      requirements: current.requirements,
      settings: current.settings,
    };
    try {
      persistence.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: STORAGE_VERSION, workspace: measurements }),
      );
    } catch (error) {
      savingFailed = true;
      const failure = `Measurements could not be saved on this device: ${errorMessage(error)}. Your latest changes remain in this page only; previously saved measurements may be older. ${SESSION_NOTICE}`;
      return {
        notice: failure,
        activity: event('system', 'Local measurement save failed', failure),
      };
    }
    if (restorationFailed || savingFailed) {
      restorationFailed = false;
      savingFailed = false;
      const recovery = `Current measurements are now saved locally. Any previously rejected or unreadable saved data has been replaced. ${SESSION_NOTICE}`;
      return { notice: recovery, activity: event('system', 'Local measurements saved', recovery) };
    }
    return null;
  }

  function changeWorkspace(
    next: Workspace,
    action: string,
    detail: string,
    reset = false,
    replacementNotice?: string,
  ): void {
    assertRevision(next.revision);
    validateWorkspace(next);
    const previous = snapshot.workspace;
    if (!reset && sameMeasurements(previous, next)) return;
    if (previous.revision === Number.MAX_SAFE_INTEGER) {
      throw new WorkshopError(
        'REVISION_LIMIT',
        'This page has reached the maximum safe workspace revision. Save your measurements and open a new page session.',
      );
    }
    const revised = { ...next, revision: previous.revision + 1 };
    const invalidation =
      snapshot.reviewPlanId !== null || snapshot.approvedPlanId !== null
        ? ' The measurement change invalidated the current review and approval.'
        : '';
    let events = appendEvents(
      snapshot.events,
      event('human', action, `${detail} Workspace revision ${revised.revision}.${invalidation}`),
    );
    let nextNotice = replacementNotice === undefined ? snapshot.notice : replacementNotice;
    const saved = saveMeasurements(revised);
    assertRevision(previous.revision);
    if (saved !== null) {
      nextNotice =
        replacementNotice === undefined ? saved.notice : `${replacementNotice} ${saved.notice}`;
      if (saved.activity !== undefined) events = appendEvents(events, saved.activity);
    }
    publish({
      ...snapshot,
      workspace: revised,
      pendingMeasurements: reset ? false : snapshot.pendingMeasurements,
      plans: reset ? [] : snapshot.plans,
      selectedPlanId: reset ? null : snapshot.selectedPlanId,
      reviewPlanId: null,
      approvedPlanId: null,
      events,
      notice: nextNotice,
    });
  }

  function newMeasurementId(prefix: string): string {
    let id: string;
    do {
      id = nextId(prefix);
    } while (
      snapshot.workspace.stock.some((board) => board.id === id) ||
      snapshot.workspace.requirements.some((part) => part.id === id)
    );
    return id;
  }

  function findPlan(id: string): PlanRecord {
    const plan = snapshot.plans.find((candidate) => candidate.id === id);
    if (!plan)
      throw new WorkshopError(
        'PLAN_NOT_FOUND',
        'That plan is not in this page session. Select an existing plan or propose a new one.',
        { planId: id },
      );
    return plan;
  }

  function freshCompletePlan(id: string): PlanRecord {
    const plan = findPlan(id);
    const current = snapshot.workspace;
    if (plan.basedOnRevision !== current.revision) {
      throw new WorkshopError(
        'STALE_PLAN',
        `This plan uses revision ${plan.basedOnRevision}, but the workspace is now revision ${current.revision}. Propose a new plan.`,
        {
          planId: id,
          basedOnRevision: plan.basedOnRevision,
          currentRevision: current.revision,
        },
      );
    }
    if (!plan.solution.complete) {
      throw new WorkshopError(
        'INCOMPLETE_PLAN',
        'An incomplete plan cannot be staged, approved, or exported. Resolve every unfulfilled quantity first.',
        { planId: id },
      );
    }
    validateWorkspace(current);
    validateSolution(current, plan.solution);
    return plan;
  }

  function assertNoPendingMeasurements(): void {
    if (snapshot.pendingMeasurements) {
      throw new WorkshopError(
        'PENDING_MEASUREMENTS',
        'Finish or cancel measurement edits before requesting review or approving a cut sheet.',
      );
    }
  }

  const store: WorkshopStore = {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (typeof listener !== 'function')
        throw new WorkshopError(
          'INVALID_INPUT',
          'A workshop subscription requires a listener function.',
        );
      const subscription = { listener };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },

    setPendingMeasurements(pending) {
      if (typeof pending !== 'boolean') {
        throw new WorkshopError('INVALID_INPUT', 'Pending measurements must be true or false.');
      }
      if (snapshot.pendingMeasurements === pending) return;
      publish({ ...snapshot, pendingMeasurements: pending });
    },

    updateProject(patch) {
      assertFields(patch, PROJECT_FIELDS, 'Project update');
      changeWorkspace(
        { ...snapshot.workspace, ...patch },
        'Project updated',
        'Updated the project title or material description.',
      );
    },

    addStock(input) {
      assertFields(input, STOCK_INPUT_FIELDS, 'New stock board', true);
      const board = { ...input, id: newMeasurementId('stock') };
      changeWorkspace(
        { ...snapshot.workspace, stock: [...snapshot.workspace.stock, board] },
        'Stock added',
        `Added ${board.label} (${board.lengthMm} mm usable ${board.kind}).`,
      );
    },

    updateStock(id, patch) {
      assertFields(patch, STOCK_INPUT_FIELDS, 'Stock update');
      const current = snapshot.workspace;
      const index = current.stock.findIndex((board) => board.id === id);
      if (index < 0)
        throw new WorkshopError('STOCK_NOT_FOUND', 'The stock board no longer exists.', {
          stockId: id,
        });
      const board = { ...current.stock[index]!, ...patch };
      const stock = current.stock.slice();
      stock[index] = board;
      changeWorkspace(
        { ...current, stock },
        'Stock updated',
        `Updated ${board.label} (${board.lengthMm} mm usable; ${board.locked ? 'protected' : 'available'}).`,
      );
    },

    removeStock(id) {
      const current = snapshot.workspace;
      const board = current.stock.find((candidate) => candidate.id === id);
      if (!board)
        throw new WorkshopError('STOCK_NOT_FOUND', 'The stock board no longer exists.', {
          stockId: id,
        });
      changeWorkspace(
        { ...current, stock: current.stock.filter((candidate) => candidate.id !== id) },
        'Stock removed',
        `Removed ${board.label} from the recorded inventory; this does not record a physical cut.`,
      );
    },

    addRequirement(input) {
      assertFields(input, REQUIREMENT_INPUT_FIELDS, 'New cut requirement', true);
      const part = { ...input, id: newMeasurementId('part') };
      changeWorkspace(
        { ...snapshot.workspace, requirements: [...snapshot.workspace.requirements, part] },
        'Cut requirement added',
        `Requested ${part.quantity} × ${part.label} at ${part.lengthMm} mm.`,
      );
    },

    updateRequirement(id, patch) {
      assertFields(patch, REQUIREMENT_INPUT_FIELDS, 'Requirement update');
      const current = snapshot.workspace;
      const index = current.requirements.findIndex((part) => part.id === id);
      if (index < 0)
        throw new WorkshopError('REQUIREMENT_NOT_FOUND', 'The cut requirement no longer exists.', {
          requirementId: id,
        });
      const part = { ...current.requirements[index]!, ...patch };
      const requirements = current.requirements.slice();
      requirements[index] = part;
      changeWorkspace(
        { ...current, requirements },
        'Cut requirement updated',
        `Requested ${part.quantity} × ${part.label} at ${part.lengthMm} mm.`,
      );
    },

    removeRequirement(id) {
      const current = snapshot.workspace;
      const part = current.requirements.find((candidate) => candidate.id === id);
      if (!part)
        throw new WorkshopError('REQUIREMENT_NOT_FOUND', 'The cut requirement no longer exists.', {
          requirementId: id,
        });
      changeWorkspace(
        {
          ...current,
          requirements: current.requirements.filter((candidate) => candidate.id !== id),
        },
        'Cut requirement removed',
        `Removed the ${part.label} requirement.`,
      );
    },

    setSettings(patch) {
      assertFields(patch, SETTINGS_FIELDS, 'Planner settings update');
      const settings = { ...snapshot.workspace.settings, ...patch };
      changeWorkspace(
        { ...snapshot.workspace, settings },
        'Physical settings updated',
        `Set saw kerf to ${settings.kerfMm} mm per part and the reusable-remnant threshold to ${settings.minReusableMm} mm.`,
      );
    },

    resetSample() {
      changeWorkspace(
        createSampleWorkspace(snapshot.workspace.revision),
        'Illustrative sample reset',
        'Replaced the workspace with the original illustrative measurements and cleared all plans.',
        true,
        SAMPLE_NOTICE,
      );
    },

    clearWorkspace() {
      changeWorkspace(
        createEmptyWorkspace(snapshot.workspace.revision),
        'Workspace cleared',
        'Started an empty workspace and cleared all plans; no stock cutting was recorded.',
        true,
        `An empty workspace is ready for your actual usable stock and cut requirements. ${SESSION_NOTICE}`,
      );
    },

    proposePlan(input, actor = 'human') {
      assertFields(input, PLAN_REQUEST_FIELDS, 'Plan request');
      assertActor(actor);
      assertRevision(input.expectedRevision);
      if (input.excludedStockIds !== undefined && !Array.isArray(input.excludedStockIds)) {
        throw new WorkshopError(
          'INVALID_INPUT',
          'Additional stock exclusions must be an array of existing stock IDs.',
        );
      }
      const current = snapshot.workspace;
      validateWorkspace(current);
      if (
        typeof input.objective !== 'string' ||
        !Object.prototype.hasOwnProperty.call(OBJECTIVES, input.objective)
      ) {
        throw new WorkshopError(
          'INVALID_OBJECTIVE',
          'Choose least_stock, fewest_boards or least_waste.',
        );
      }
      const additionalExclusions = new Set<string>();
      if (input.excludedStockIds !== undefined) {
        if (input.excludedStockIds.length > LIMITS.stockBoards) {
          throw new WorkshopError(
            'INVALID_EXCLUSIONS',
            `Exclude at most ${LIMITS.stockBoards} stock boards.`,
          );
        }
        for (const id of input.excludedStockIds) {
          if (typeof id !== 'string') {
            throw new WorkshopError(
              'INVALID_EXCLUSIONS',
              'Every excluded stock ID must be a string.',
            );
          }
          if (!current.stock.some((board) => board.id === id)) {
            throw new WorkshopError(
              'UNKNOWN_STOCK',
              `Excluded stock ID "${id}" is not in this workspace.`,
              { stockId: id },
            );
          }
          if (additionalExclusions.has(id)) {
            throw new WorkshopError(
              'INVALID_EXCLUSIONS',
              'Additional stock exclusions must name distinct existing stock boards.',
            );
          }
          additionalExclusions.add(id);
        }
      }
      if (current.requirements.length === 0) {
        throw new WorkshopError(
          'NO_REQUIREMENTS',
          'Add at least one required part before finding a cutting plan.',
        );
      }
      // Use the solver's workspace-order canonical ADDITIONAL set, including protected IDs.
      const exclusions: string[] = [];
      for (const board of current.stock) {
        if (additionalExclusions.has(board.id)) exclusions.push(board.id);
      }
      const reused = snapshot.plans.find(
        (candidate) =>
          candidate.basedOnRevision === current.revision &&
          candidate.solution.objective === input.objective &&
          candidate.solution.excludedStockIds.length === exclusions.length &&
          candidate.solution.excludedStockIds.every((id, index) => id === exclusions[index]),
      );
      const solution = reused?.solution ?? solveCutPlan(current, input.objective, exclusions);
      assertRevision(current.revision);
      validateSolution(current, solution, input.objective, exclusions);
      const plan: PlanRecord = {
        id: nextId('plan'),
        basedOnRevision: current.revision,
        createdAt: new Date().toISOString(),
        actor,
        reusedFromPlanId: reused?.id ?? null,
        solution,
      };
      const plans = [...snapshot.plans, plan];
      while (plans.length > LIMITS.savedPlans) {
        const oldestUnprotected = plans.findIndex(
          (candidate) =>
            candidate.id !== snapshot.approvedPlanId &&
            candidate.id !== snapshot.reviewPlanId &&
            candidate.id !== plan.id,
        );
        plans.splice(oldestUnprotected, 1);
      }
      publish({
        ...snapshot,
        plans,
        selectedPlanId: plan.id,
        events: appendEvents(
          snapshot.events,
          event(
            actor,
            'Plan proposed',
            `${OBJECTIVES[solution.objective].label}: ${solution.complete ? 'all requested parts fit' : 'some requested parts remain unfulfilled'}. Plan ${plan.id}, revision ${current.revision}.${reused ? ` Reused the checked solution from plan ${reused.id}; search statistics describe its original computation, with no new solver search.` : ''}`,
          ),
        ),
      });
      return plan;
    },

    selectPlan(id) {
      const plan = findPlan(id);
      if (snapshot.selectedPlanId === id) return;
      publish({
        ...snapshot,
        selectedPlanId: id,
        events: appendEvents(
          snapshot.events,
          event(
            'human',
            'Plan selected',
            `Selected plan ${id}, based on revision ${plan.basedOnRevision}, for inspection.`,
          ),
        ),
      });
    },

    stagePlan(id, expectedRevision, actor = 'human') {
      assertActor(actor);
      assertRevision(expectedRevision);
      const plan = freshCompletePlan(id);
      assertNoPendingMeasurements();
      if (snapshot.reviewPlanId === id && snapshot.selectedPlanId === id) return plan;
      publish({
        ...snapshot,
        reviewPlanId: id,
        selectedPlanId: id,
        events: appendEvents(
          snapshot.events,
          event(
            actor,
            'Plan staged for human review',
            `Plan ${id} at revision ${plan.basedOnRevision} is awaiting an explicit human approval decision.`,
          ),
        ),
      });
      return plan;
    },

    approvePlan(id) {
      const plan = freshCompletePlan(id);
      if (snapshot.reviewPlanId !== id) {
        throw new WorkshopError(
          'REVIEW_REQUIRED',
          'Only the plan currently staged for human review can be approved.',
          { planId: id, reviewPlanId: snapshot.reviewPlanId },
        );
      }
      assertNoPendingMeasurements();
      publish({
        ...snapshot,
        approvedPlanId: id,
        reviewPlanId: null,
        events: appendEvents(
          snapshot.events,
          event(
            'human',
            'Plan approved',
            `Approved the checked cut sheet for plan ${id} at revision ${plan.basedOnRevision}. This does not consume stock or record fabrication.`,
          ),
        ),
      });
      return plan;
    },

    rejectReview() {
      const id = snapshot.reviewPlanId;
      if (id === null) return;
      const wasApproved = snapshot.approvedPlanId === id;
      publish({
        ...snapshot,
        reviewPlanId: null,
        approvedPlanId: wasApproved ? null : snapshot.approvedPlanId,
        events: appendEvents(
          snapshot.events,
          event(
            'human',
            'Review rejected',
            `Rejected the staged review of plan ${id}.${wasApproved ? ' Its earlier approval was also revoked.' : ''}`,
          ),
        ),
      });
    },

    revokeApproval() {
      const id = snapshot.approvedPlanId;
      if (id === null) return;
      publish({
        ...snapshot,
        approvedPlanId: null,
        events: appendEvents(
          snapshot.events,
          event(
            'human',
            'Approval revoked',
            `Revoked approval for plan ${id}. Export requires a new explicit human review and approval.`,
          ),
        ),
      });
    },

    setBridge(state: BridgeState) {
      assertFields(state, BRIDGE_FIELDS, 'Browser bridge', true);
      if (
        !BRIDGE_STATES.includes(state.state) ||
        (state.provider !== null &&
          state.provider !== 'document' &&
          state.provider !== 'navigator') ||
        !Number.isSafeInteger(state.registeredTools) ||
        state.registeredTools < 0 ||
        typeof state.message !== 'string' ||
        state.message.trim().length === 0 ||
        (state.registeredTools > 0 && state.provider === null) ||
        (state.state === 'ready' && (state.provider === null || state.registeredTools === 0))
      ) {
        throw new WorkshopError(
          'INVALID_INPUT',
          'Browser bridge state must report a valid native provider, actual tool count, and a useful status message.',
        );
      }
      const previous = snapshot.bridge;
      if (
        previous.state === state.state &&
        previous.provider === state.provider &&
        previous.registeredTools === state.registeredTools &&
        previous.message === state.message
      )
        return;
      publish({
        ...snapshot,
        bridge: { ...state },
        events: appendEvents(
          snapshot.events,
          event(
            'system',
            'Browser bridge updated',
            `${state.message} Registered native tools: ${state.registeredTools}.`,
          ),
        ),
      });
    },

    recordActivity(actor, action, detail) {
      assertActor(actor);
      if (typeof action !== 'string' || action.trim().length === 0 || typeof detail !== 'string') {
        throw new WorkshopError(
          'INVALID_INPUT',
          'Activity must contain a nonblank action and a text detail.',
        );
      }
      publish({ ...snapshot, events: appendEvents(snapshot.events, event(actor, action, detail)) });
    },

    recordExport(id, actor = 'human') {
      assertActor(actor);
      const plan = freshCompletePlan(id);
      if (snapshot.approvedPlanId !== id) {
        throw new WorkshopError(
          'APPROVAL_REQUIRED',
          'Export is available only for the currently approved fresh plan.',
          { planId: id, approvedPlanId: snapshot.approvedPlanId },
        );
      }
      publish({
        ...snapshot,
        events: appendEvents(
          snapshot.events,
          event(
            actor,
            'Approved cut sheet exported',
            `Released the approved cut list for plan ${id} at revision ${plan.basedOnRevision}. No physical cutting or stock depletion was recorded.`,
          ),
        ),
      });
    },

    dismissNotice() {
      if (snapshot.notice !== null) publish({ ...snapshot, notice: null });
    },
  };

  return store;
}

export const workshopStore = createWorkshopStore();
