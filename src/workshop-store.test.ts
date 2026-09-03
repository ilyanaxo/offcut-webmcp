import { describe, expect, test } from 'bun:test';
import { WorkshopError } from './errors';
import { createSampleWorkspace } from './sample';
import { LIMITS } from './types';
import type {
  Actor,
  Objective,
  PlanRecord,
  PlanRequest,
  WorkshopSnapshot,
  WorkshopStore,
  Workspace,
} from './types';
import { createWorkshopStore } from './workshop-store';

const STORAGE_KEY = 'offcut.measurements.v1';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    failReads: false,
    failWrites: false,
    writeAttempts: 0,
    getItem(key: string) {
      if (this.failReads) throw new Error('Storage access denied');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      this.writeAttempts++;
      if (this.failWrites) throw new Error('Storage quota exhausted');
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

function createJob(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null,
): WorkshopStore {
  const store = createWorkshopStore(storage);
  store.clearWorkspace();
  store.updateProject({
    title: 'Boundary shelf project',
    material: 'Pine, identical cross-section',
  });
  store.setSettings({ kerfMm: 3, minReusableMm: 100 });
  store.addStock({ label: 'Short board one', lengthMm: 700, kind: 'board', locked: false });
  store.addStock({ label: 'Short board two', lengthMm: 700, kind: 'offcut', locked: false });
  store.addStock({ label: 'Long board', lengthMm: 1500, kind: 'board', locked: false });
  store.addStock({ label: 'Protected reserve', lengthMm: 1500, kind: 'board', locked: true });
  store.addRequirement({ label: 'Shelf', lengthMm: 600, quantity: 2 });
  return store;
}

function propose(store: WorkshopStore, objective: Objective = 'least_stock'): PlanRecord {
  return store.proposePlan({ expectedRevision: store.getSnapshot().workspace.revision, objective });
}

function approve(store: WorkshopStore, plan: PlanRecord): void {
  store.stagePlan(plan.id, store.getSnapshot().workspace.revision);
  store.approvePlan(plan.id);
}

function approvedAndReviewing(store: WorkshopStore) {
  const approved = propose(store);
  approve(store, approved);
  const reviewing = propose(store, 'fewest_boards');
  store.stagePlan(reviewing.id, store.getSnapshot().workspace.revision);
  return { approved, reviewing };
}

function expectCode(action: () => unknown, code: string): WorkshopError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkshopError);
    expect((error as WorkshopError).code).toBe(code);
    return error as WorkshopError;
  }
  throw new Error(`Expected WorkshopError ${code}`);
}

function measurements(workspace: Workspace): Omit<Workspace, 'revision'> {
  return {
    title: workspace.title,
    material: workspace.material,
    stock: workspace.stock,
    requirements: workspace.requirements,
    settings: workspace.settings,
  };
}

function expectNoRestoredSession(snapshot: WorkshopSnapshot, prior: WorkshopSnapshot): void {
  expect(snapshot.plans).toEqual([]);
  expect(snapshot.selectedPlanId).toBeNull();
  expect(snapshot.reviewPlanId).toBeNull();
  expect(snapshot.approvedPlanId).toBeNull();
  expect(snapshot.pendingMeasurements).toBe(false);
  expect(snapshot.events.length).toBeGreaterThan(0);
  expect(snapshot.events.every((event) => event.actor === 'system')).toBe(true);
  const oldEvents = new Set(prior.events.map((event) => event.id));
  expect(snapshot.events.some((event) => oldEvents.has(event.id))).toBe(false);
}

type HumanEdit = { name: string; apply(store: WorkshopStore, workspace: Workspace): void };

const humanEdits: HumanEdit[] = [
  {
    name: 'project title',
    apply: (store) => store.updateProject({ title: 'A different project' }),
  },
  {
    name: 'material',
    apply: (store) => store.updateProject({ material: 'Oak, identical cross-section' }),
  },
  {
    name: 'stock label',
    apply: (store, workspace) =>
      store.updateStock(workspace.stock[0]!.id, { label: 'Relabelled board' }),
  },
  {
    name: 'stock length',
    apply: (store, workspace) => store.updateStock(workspace.stock[0]!.id, { lengthMm: 701 }),
  },
  {
    name: 'stock kind',
    apply: (store, workspace) => store.updateStock(workspace.stock[0]!.id, { kind: 'offcut' }),
  },
  {
    name: 'stock protection',
    apply: (store, workspace) => store.updateStock(workspace.stock[0]!.id, { locked: true }),
  },
  {
    name: 'requirement label',
    apply: (store, workspace) =>
      store.updateRequirement(workspace.requirements[0]!.id, { label: 'Relabelled shelf' }),
  },
  {
    name: 'requirement length',
    apply: (store, workspace) =>
      store.updateRequirement(workspace.requirements[0]!.id, { lengthMm: 601 }),
  },
  {
    name: 'requirement quantity',
    apply: (store, workspace) =>
      store.updateRequirement(workspace.requirements[0]!.id, { quantity: 1 }),
  },
  { name: 'saw kerf', apply: (store) => store.setSettings({ kerfMm: 4 }) },
  { name: 'reusable threshold', apply: (store) => store.setSettings({ minReusableMm: 101 }) },
  {
    name: 'stock addition',
    apply: (store) =>
      store.addStock({ label: 'New offcut', lengthMm: 650, kind: 'offcut', locked: false }),
  },
  { name: 'stock removal', apply: (store, workspace) => store.removeStock(workspace.stock[0]!.id) },
  {
    name: 'requirement addition',
    apply: (store) => store.addRequirement({ label: 'Brace', lengthMm: 100, quantity: 1 }),
  },
  {
    name: 'requirement removal',
    apply: (store, workspace) => store.removeRequirement(workspace.requirements[0]!.id),
  },
];

describe('human measurement commits', () => {
  test.each([false, true])(
    'equal and empty edits are no-ops with failing storage and pending=%s',
    (pending) => {
      const storage = memoryStorage();
      const store = createJob(storage);
      approvedAndReviewing(store);
      store.setPendingMeasurements(pending);
      storage.failWrites = true;
      const writeAttempts = storage.writeAttempts;
      let notifications = 0;
      const unsubscribe = store.subscribe(() => {
        notifications++;
      });
      const before = store.getSnapshot();
      const workspace = before.workspace;
      const board = workspace.stock[0]!;
      const part = workspace.requirements[0]!;
      const equalEdits = [
        () => store.updateProject({ title: workspace.title, material: workspace.material }),
        () =>
          store.updateStock(board.id, {
            label: board.label,
            lengthMm: board.lengthMm,
            kind: board.kind,
            locked: board.locked,
          }),
        () =>
          store.updateRequirement(part.id, {
            label: part.label,
            lengthMm: part.lengthMm,
            quantity: part.quantity,
          }),
        () => store.setSettings({ ...workspace.settings }),
        () => store.updateProject({}),
        () => store.updateStock(board.id, {}),
        () => store.updateRequirement(part.id, {}),
        () => store.setSettings({}),
      ];
      for (const edit of equalEdits) {
        edit();
        expect(store.getSnapshot()).toBe(before);
        expect(storage.writeAttempts).toBe(writeAttempts);
        expect(notifications).toBe(0);
      }
      unsubscribe();
    },
  );

  test.each(humanEdits)(
    '$name changes revise once and invalidate both release decisions',
    ({ apply }) => {
      const store = createJob();
      const { approved, reviewing } = approvedAndReviewing(store);
      store.setPendingMeasurements(true);
      const before = store.getSnapshot();
      apply(store, before.workspace);
      const after = store.getSnapshot();
      expect(after.workspace.revision).toBe(before.workspace.revision + 1);
      expect(after.pendingMeasurements).toBe(true);
      expect(measurements(after.workspace)).not.toEqual(measurements(before.workspace));
      expect(after.reviewPlanId).toBeNull();
      expect(after.approvedPlanId).toBeNull();
      expect(after.selectedPlanId).toBe(reviewing.id);
      expect(after.plans).toBe(before.plans);
      expect(after.plans.map((plan) => plan.basedOnRevision)).toEqual([
        before.workspace.revision,
        before.workspace.revision,
      ]);
      expect(after.events.at(-1)).toMatchObject({ actor: 'human' });
      expect(after.events.at(-1)!.detail).toContain('invalidated');
      expectCode(() => store.stagePlan(reviewing.id, after.workspace.revision), 'STALE_PLAN');
      expectCode(() => store.approvePlan(approved.id), 'STALE_PLAN');
      expectCode(() => store.recordExport(approved.id), 'STALE_PLAN');
      expect(store.getSnapshot()).toBe(after);
      expect(before.reviewPlanId).toBe(reviewing.id);
      expect(before.approvedPlanId).toBe(approved.id);
    },
  );

  test('invalid human edits fail atomically instead of invalidating a valid decision', () => {
    const store = createJob();
    approvedAndReviewing(store);
    store.setPendingMeasurements(true);
    const before = store.getSnapshot();
    const board = before.workspace.stock[0]!;
    const part = before.workspace.requirements[0]!;
    const invalidEdits = [
      () => store.updateProject({ title: '   ' }),
      () => store.updateStock(board.id, { lengthMm: 0 }),
      () => store.updateRequirement(part.id, { quantity: 1.5 }),
      () => store.setSettings({ kerfMm: -1 }),
      () => store.setSettings({ minReusableMm: LIMITS.lengthMm + 1 }),
    ];
    for (const edit of invalidEdits) {
      expectCode(edit, 'INVALID_WORKSPACE');
      expect(store.getSnapshot()).toBe(before);
    }
    expectCode(() => store.updateStock('missing-stock', { locked: false }), 'STOCK_NOT_FOUND');
    expectCode(
      () => store.updateRequirement('missing-part', { quantity: 1 }),
      'REQUIREMENT_NOT_FOUND',
    );
    expect(store.getSnapshot()).toBe(before);
  });

  test('old and future expected revisions reject proposals and staging without a side effect', () => {
    const store = createJob();
    const plan = propose(store);
    const oldRevision = store.getSnapshot().workspace.revision;
    store.updateProject({ title: 'Human committed a newer title' });
    const before = store.getSnapshot();
    for (const expectedRevision of [oldRevision, before.workspace.revision + 1]) {
      for (const call of [
        () => store.proposePlan({ expectedRevision, objective: 'least_stock' }),
        () => store.stagePlan(plan.id, expectedRevision, 'webmcp'),
      ]) {
        const error = expectCode(call, 'REVISION_CONFLICT');
        expect(error.details).toEqual({
          expectedRevision,
          currentRevision: before.workspace.revision,
        });
        expect(store.getSnapshot()).toBe(before);
      }
    }
  });
});

describe('pending measurement state and publication guards', () => {
  test('flag changes publish only an ephemeral immutable root and equal flags are strict no-ops', () => {
    const storage = memoryStorage();
    const store = createJob(storage);
    approvedAndReviewing(store);
    const committed = store.getSnapshot();
    const saved = storage.getItem(STORAGE_KEY);
    const writeAttempts = storage.writeAttempts;
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications++;
    });
    const reportPending = store.setPendingMeasurements;
    expect(committed.pendingMeasurements).toBe(false);
    reportPending(false);
    expect(store.getSnapshot()).toBe(committed);
    expect(notifications).toBe(0);
    reportPending(true);
    const pending = store.getSnapshot();
    expect(pending).not.toBe(committed);
    expect(pending).toEqual({ ...committed, pendingMeasurements: true });
    expect(Object.isFrozen(pending)).toBe(true);
    expect(pending.workspace).toBe(committed.workspace);
    expect(pending.plans).toBe(committed.plans);
    expect(pending.events).toBe(committed.events);
    expect(pending.bridge).toBe(committed.bridge);
    expect(notifications).toBe(1);
    reportPending(true);
    expect(store.getSnapshot()).toBe(pending);
    expect(notifications).toBe(1);
    reportPending(false);
    const settled = store.getSnapshot();
    expect(settled).not.toBe(pending);
    expect(settled).toEqual(committed);
    expect(settled.workspace).toBe(committed.workspace);
    expect(settled.plans).toBe(committed.plans);
    expect(settled.events).toBe(committed.events);
    expect(settled.bridge).toBe(committed.bridge);
    expect(notifications).toBe(2);
    reportPending(false);
    expect(store.getSnapshot()).toBe(settled);
    expect(notifications).toBe(2);
    expect(storage.getItem(STORAGE_KEY)).toBe(saved);
    expect(storage.writeAttempts).toBe(writeAttempts);
    expect(committed.pendingMeasurements).toBe(false);
    expect(pending.pendingMeasurements).toBe(true);
    unsubscribe();
  });

  test.each([false, true])('non-boolean flags reject atomically when pending=%s', (pending) => {
    const store = createJob();
    approvedAndReviewing(store);
    store.setPendingMeasurements(pending);
    const before = store.getSnapshot();
    for (const value of [undefined, null, 0, 1, 'false', 'true', {}, []]) {
      expectCode(() => store.setPendingMeasurements(value as unknown as boolean), 'INVALID_INPUT');
      expect(store.getSnapshot()).toBe(before);
    }
  });

  test.each(['human', 'webmcp'] as const)(
    'pending drafts block %s review staging until they settle',
    (actor) => {
      const store = createJob();
      const workspace = store.getSnapshot().workspace;
      store.setPendingMeasurements(true);
      const plan = store.proposePlan(
        { expectedRevision: workspace.revision, objective: 'least_stock' },
        actor,
      );
      expect(plan.reusedFromPlanId).toBeNull();
      const pending = store.getSnapshot();
      expect(pending.workspace).toBe(workspace);
      expectCode(
        () => store.stagePlan(plan.id, pending.workspace.revision, actor),
        'PENDING_MEASUREMENTS',
      );
      expect(store.getSnapshot()).toBe(pending);
      expect(pending.reviewPlanId).toBeNull();
      expect(pending.approvedPlanId).toBeNull();
      store.setPendingMeasurements(false);
      expect(store.stagePlan(plan.id, pending.workspace.revision, actor)).toBe(plan);
      const reviewing = store.getSnapshot();
      expect(reviewing.workspace).toBe(pending.workspace);
      expect(reviewing.reviewPlanId).toBe(plan.id);
      expect(store.stagePlan(plan.id, pending.workspace.revision, actor)).toBe(plan);
      expect(store.getSnapshot()).toBe(reviewing);
    },
  );

  test('drafts preserve exact committed approval and review but forbid restaging and approval', () => {
    const store = createJob();
    const { approved, reviewing } = approvedAndReviewing(store);
    store.setPendingMeasurements(true);
    const pending = store.getSnapshot();
    expectCode(
      () => store.stagePlan(reviewing.id, pending.workspace.revision, 'webmcp'),
      'PENDING_MEASUREMENTS',
    );
    expectCode(() => store.approvePlan(reviewing.id), 'PENDING_MEASUREMENTS');
    expect(store.getSnapshot()).toBe(pending);
    const draft = store.proposePlan(
      { expectedRevision: pending.workspace.revision, objective: approved.solution.objective },
      'webmcp',
    );
    const proposed = store.getSnapshot();
    expect(proposed.workspace).toBe(pending.workspace);
    expect(proposed.pendingMeasurements).toBe(true);
    expect(proposed.approvedPlanId).toBe(approved.id);
    expect(proposed.reviewPlanId).toBe(reviewing.id);
    expect(draft.id).not.toBe(approved.id);
    expect(draft.reusedFromPlanId).toBe(approved.id);
    expect(draft.solution).toBe(approved.solution);
    expectCode(() => store.recordExport(draft.id, 'webmcp'), 'APPROVAL_REQUIRED');
    expectCode(() => store.approvePlan(draft.id), 'REVIEW_REQUIRED');
    expectCode(
      () => store.stagePlan(draft.id, pending.workspace.revision, 'webmcp'),
      'PENDING_MEASUREMENTS',
    );
    expect(store.getSnapshot()).toBe(proposed);
    store.recordExport(approved.id, 'webmcp');
    const exported = store.getSnapshot();
    expect(exported.workspace).toBe(pending.workspace);
    expect(exported.approvedPlanId).toBe(approved.id);
    expect(exported.reviewPlanId).toBe(reviewing.id);
    expect(exported.pendingMeasurements).toBe(true);
    expect(exported.events.at(-1)).toMatchObject({
      actor: 'webmcp',
      action: 'Approved cut sheet exported',
    });
    store.setPendingMeasurements(false);
    expect(store.getSnapshot().approvedPlanId).toBe(approved.id);
    expect(store.getSnapshot().reviewPlanId).toBe(reviewing.id);
    expect(store.approvePlan(reviewing.id)).toBe(reviewing);
    expect(store.getSnapshot().approvedPlanId).toBe(reviewing.id);
  });

  test('pending publication errors do not replace actor, revision, identity, completeness or review errors', () => {
    const store = createJob();
    const stale = propose(store);
    store.updateProject({ title: 'A newer committed job' });
    const fresh = propose(store);
    const other = propose(store, 'fewest_boards');
    const workspace = store.getSnapshot().workspace;
    const partial = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'least_stock',
      excludedStockIds: workspace.stock.filter((board) => !board.locked).map((board) => board.id),
    });
    expect(partial.solution.complete).toBe(false);
    store.stagePlan(fresh.id, workspace.revision);
    store.setPendingMeasurements(true);
    const before = store.getSnapshot();
    const rejections: [() => unknown, string][] = [
      [() => store.stagePlan(fresh.id, workspace.revision, 'agent' as Actor), 'INVALID_INPUT'],
      [() => store.stagePlan(fresh.id, -1), 'INVALID_INPUT'],
      [() => store.stagePlan(fresh.id, stale.basedOnRevision), 'REVISION_CONFLICT'],
      [() => store.stagePlan('missing-plan', workspace.revision), 'PLAN_NOT_FOUND'],
      [() => store.approvePlan('missing-plan'), 'PLAN_NOT_FOUND'],
      [() => store.stagePlan(stale.id, workspace.revision), 'STALE_PLAN'],
      [() => store.approvePlan(stale.id), 'STALE_PLAN'],
      [() => store.stagePlan(partial.id, workspace.revision), 'INCOMPLETE_PLAN'],
      [() => store.approvePlan(partial.id), 'INCOMPLETE_PLAN'],
      [() => store.approvePlan(other.id), 'REVIEW_REQUIRED'],
      [() => store.stagePlan(fresh.id, workspace.revision), 'PENDING_MEASUREMENTS'],
      [() => store.approvePlan(fresh.id), 'PENDING_MEASUREMENTS'],
    ];
    for (const [call, code] of rejections) {
      expectCode(call, code);
      expect(store.getSnapshot()).toBe(before);
    }
  });
});

describe('exact-plan review and release transitions', () => {
  test('protected and additionally excluded stock cannot enter a complete reviewed plan', () => {
    const store = createJob();
    const before = store.getSnapshot().workspace;
    const excluded = before.stock[0]!;
    const protectedBoard = before.stock.find((board) => board.locked)!;
    const exclusions = [excluded.id, protectedBoard.id];
    const plan = store.proposePlan(
      { expectedRevision: before.revision, objective: 'least_stock', excludedStockIds: exclusions },
      'webmcp',
    );
    exclusions.push(before.stock[2]!.id);
    expect(plan.solution.complete).toBe(true);
    expect(plan.solution.excludedStockIds).toEqual([excluded.id, protectedBoard.id]);
    expect(plan.solution.layouts.map((layout) => layout.stockId)).toEqual([before.stock[2]!.id]);
    expect(
      plan.solution.layouts
        .flatMap((layout) => layout.cuts)
        .map((cut) => cut.instance)
        .sort(),
    ).toEqual([1, 2]);
    approve(store, plan);
    store.recordExport(plan.id);
    expect(store.getSnapshot().workspace).toBe(before);
    expect(
      store.getSnapshot().workspace.stock.find((board) => board.id === protectedBoard.id)!.locked,
    ).toBe(true);
    expect(plan.actor).toBe('webmcp');
  });

  test('an actual partial result cannot be staged, approved or recorded as an export', () => {
    const store = createJob();
    const workspace = store.getSnapshot().workspace;
    const plan = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'fewest_boards',
      excludedStockIds: workspace.stock.filter((board) => !board.locked).map((board) => board.id),
    });
    expect(plan.solution.complete).toBe(false);
    expect(plan.solution.layouts).toEqual([]);
    expect(plan.solution.unfulfilled).toMatchObject([
      { requirementId: workspace.requirements[0]!.id, quantity: 2 },
    ]);
    const before = store.getSnapshot();
    for (const call of [
      () => store.stagePlan(plan.id, workspace.revision),
      () => store.approvePlan(plan.id),
      () => store.recordExport(plan.id),
    ]) {
      expectCode(call, 'INCOMPLETE_PLAN');
      expect(store.getSnapshot()).toBe(before);
    }
  });

  test('approval follows the current staged ID, not a prior stage or selected alternative', () => {
    const store = createJob();
    const first = propose(store);
    const second = propose(store, 'fewest_boards');
    const workspace = store.getSnapshot().workspace;
    const unstaged = store.getSnapshot();
    expectCode(() => store.approvePlan(first.id), 'REVIEW_REQUIRED');
    expect(store.getSnapshot()).toBe(unstaged);
    expect(store.stagePlan(first.id, workspace.revision)).toBe(first);
    expect(store.getSnapshot()).toMatchObject({
      reviewPlanId: first.id,
      selectedPlanId: first.id,
      approvedPlanId: null,
    });
    expect(store.stagePlan(second.id, workspace.revision, 'webmcp')).toBe(second);
    expect(store.getSnapshot()).toMatchObject({
      reviewPlanId: second.id,
      selectedPlanId: second.id,
      approvedPlanId: null,
    });
    store.selectPlan(first.id);
    const beforeApproval = store.getSnapshot();
    const error = expectCode(() => store.approvePlan(first.id), 'REVIEW_REQUIRED');
    expect(error.details).toEqual({ planId: first.id, reviewPlanId: second.id });
    expect(store.getSnapshot()).toBe(beforeApproval);
    expect(store.approvePlan(second.id)).toBe(second);
    expect(store.getSnapshot()).toMatchObject({
      approvedPlanId: second.id,
      reviewPlanId: null,
      selectedPlanId: first.id,
    });
    expect(store.getSnapshot().events.at(-1)).toMatchObject({
      actor: 'human',
      action: 'Plan approved',
    });
    expect(store.getSnapshot().workspace).toBe(workspace);
    expectCode(() => store.recordExport(first.id), 'APPROVAL_REQUIRED');
    store.recordExport(second.id);
    expect(store.getSnapshot().events.at(-1)!.detail).toContain(second.id);
  });

  test('unknown IDs cannot select, stage, approve or export a substitute plan', () => {
    const store = createJob();
    approvedAndReviewing(store);
    const before = store.getSnapshot();
    for (const call of [
      () => store.selectPlan('not-in-this-session'),
      () => store.stagePlan('not-in-this-session', before.workspace.revision),
      () => store.approvePlan('not-in-this-session'),
      () => store.recordExport('not-in-this-session'),
    ]) {
      expectCode(call, 'PLAN_NOT_FOUND');
      expect(store.getSnapshot()).toBe(before);
    }
  });

  test('revocation preserves an unrelated staged review but forbids reusing the old approval', () => {
    const store = createJob();
    const { approved, reviewing } = approvedAndReviewing(store);
    const before = store.getSnapshot();
    store.revokeApproval();
    const revoked = store.getSnapshot();
    expect(revoked).toMatchObject({
      approvedPlanId: null,
      reviewPlanId: reviewing.id,
      selectedPlanId: reviewing.id,
    });
    expect(revoked.workspace).toBe(before.workspace);
    expect(revoked.plans).toBe(before.plans);
    expect(revoked.events.at(-1)).toMatchObject({ actor: 'human', action: 'Approval revoked' });
    store.revokeApproval();
    expect(store.getSnapshot()).toBe(revoked);
    expectCode(() => store.recordExport(approved.id), 'APPROVAL_REQUIRED');
    expectCode(() => store.approvePlan(approved.id), 'REVIEW_REQUIRED');
    store.rejectReview();
    expectCode(() => store.approvePlan(approved.id), 'REVIEW_REQUIRED');
    approve(store, approved);
    store.recordExport(approved.id);
    expect(store.getSnapshot().approvedPlanId).toBe(approved.id);
    expect(store.getSnapshot().workspace).toBe(before.workspace);
  });

  test('rejecting a different review keeps the approval; rejecting that approved plan revokes it', () => {
    const store = createJob();
    const { approved, reviewing } = approvedAndReviewing(store);
    const workspace = store.getSnapshot().workspace;
    store.rejectReview();
    expect(store.getSnapshot()).toMatchObject({
      reviewPlanId: null,
      approvedPlanId: approved.id,
      selectedPlanId: reviewing.id,
    });
    expectCode(() => store.approvePlan(reviewing.id), 'REVIEW_REQUIRED');
    store.recordExport(approved.id);
    store.stagePlan(approved.id, workspace.revision);
    store.rejectReview();
    const rejected = store.getSnapshot();
    expect(rejected).toMatchObject({ reviewPlanId: null, approvedPlanId: null });
    expect(rejected.events.at(-1)).toMatchObject({ actor: 'human', action: 'Review rejected' });
    expect(rejected.events.at(-1)!.detail).toContain('revoked');
    expectCode(() => store.recordExport(approved.id), 'APPROVAL_REQUIRED');
    store.rejectReview();
    expect(store.getSnapshot()).toBe(rejected);
    expect(rejected.workspace).toBe(workspace);
  });

  test.each(['resetSample', 'clearWorkspace'] as const)(
    '%s clears session plans and decisions and never rewinds revision',
    (operation) => {
      const store = createJob();
      const { approved, reviewing } = approvedAndReviewing(store);
      store.setPendingMeasurements(true);
      const before = store.getSnapshot();
      store[operation]();
      const replaced = store.getSnapshot();
      expect(replaced.workspace.revision).toBe(before.workspace.revision + 1);
      expect(replaced.plans).toEqual([]);
      expect(replaced.pendingMeasurements).toBe(false);
      expect(replaced.selectedPlanId).toBeNull();
      expect(replaced.reviewPlanId).toBeNull();
      expect(replaced.approvedPlanId).toBeNull();
      expect(replaced.events.at(-1)).toMatchObject({
        actor: 'human',
        action: operation === 'resetSample' ? 'Illustrative sample reset' : 'Workspace cleared',
      });
      if (operation === 'resetSample') {
        expect(replaced.workspace).toEqual(createSampleWorkspace(before.workspace.revision + 1));
      } else {
        expect(replaced.workspace.stock).toEqual([]);
        expect(replaced.workspace.requirements).toEqual([]);
      }
      expectCode(
        () => store.stagePlan(reviewing.id, replaced.workspace.revision),
        'PLAN_NOT_FOUND',
      );
      expectCode(() => store.recordExport(approved.id), 'PLAN_NOT_FOUND');
      store[operation]();
      expect(store.getSnapshot().workspace.revision).toBe(replaced.workspace.revision + 1);
      store.updateProject({ title: 'New measurements after replacement' });
      expect(store.getSnapshot().workspace.revision).toBe(replaced.workspace.revision + 2);
      expect(store.getSnapshot().plans).toEqual([]);
    },
  );

  test('proposal pruning retains the exact approved and staged plans while discarding old drafts', () => {
    const store = createJob();
    const { approved, reviewing } = approvedAndReviewing(store);
    const disposable = propose(store, 'least_waste');
    for (let index = 0; index < LIMITS.savedPlans; index++) propose(store, 'fewest_boards');
    const snapshot = store.getSnapshot();
    expect(snapshot.plans).toHaveLength(LIMITS.savedPlans);
    expect(snapshot.plans.find((plan) => plan.id === approved.id)).toBe(approved);
    expect(snapshot.plans.find((plan) => plan.id === reviewing.id)).toBe(reviewing);
    expect(snapshot.plans.some((plan) => plan.id === disposable.id)).toBe(false);
    expect(snapshot.approvedPlanId).toBe(approved.id);
    expect(snapshot.reviewPlanId).toBe(reviewing.id);
    store.recordExport(approved.id);
    store.approvePlan(reviewing.id);
    expect(store.getSnapshot().approvedPlanId).toBe(reviewing.id);
  });

  test('activity keeps the last 80 append-ordered events, including a two-event failed save', () => {
    const storage = memoryStorage();
    const store = createJob(storage);
    approvedAndReviewing(store);
    store.setPendingMeasurements(true);
    const before = store.getSnapshot();
    for (let index = 0; index < 85; index++) {
      store.recordActivity('webmcp', 'Inspection note', `Activity ${index}`);
    }
    const recorded = store.getSnapshot();
    expect(recorded.events).toHaveLength(80);
    expect(recorded.events.map((event) => event.detail)).toEqual(
      Array.from({ length: 80 }, (_, index) => `Activity ${index + 5}`),
    );
    expect(new Set(recorded.events.map((event) => event.id)).size).toBe(80);
    expect(recorded.workspace).toBe(before.workspace);
    expect(recorded.plans).toBe(before.plans);
    expect(recorded.reviewPlanId).toBe(before.reviewPlanId);
    expect(recorded.approvedPlanId).toBe(before.approvedPlanId);
    expect(recorded.pendingMeasurements).toBe(true);
    expect(before.events).not.toBe(recorded.events);
    expect(before.events.length).toBeLessThan(80);
    storage.failWrites = true;
    store.setSettings({ kerfMm: 4 });
    const failedSave = store.getSnapshot();
    expect(failedSave.events).toHaveLength(80);
    expect(failedSave.events[0]!.detail).toBe('Activity 7');
    expect(failedSave.events.slice(-2).map((event) => event.action)).toEqual([
      'Physical settings updated',
      'Local measurement save failed',
    ]);
    expect(recorded.events[0]!.detail).toBe('Activity 5');
    expect(failedSave.pendingMeasurements).toBe(true);
  });
});

describe('retained checked-solution reuse', () => {
  test.each(['least_stock', 'fewest_boards', 'least_waste'] as const)(
    '%s reuse creates a new frozen unapproved identity, actor, selection and honest event',
    (objective) => {
      const store = createJob();
      const first = propose(store, objective);
      expect(first.reusedFromPlanId).toBeNull();
      approve(store, first);
      const before = store.getSnapshot();
      const reused = store.proposePlan(
        { expectedRevision: before.workspace.revision, objective, excludedStockIds: [] },
        'webmcp',
      );
      const after = store.getSnapshot();
      expect(reused).not.toBe(first);
      expect(reused.id).not.toBe(first.id);
      expect(reused.reusedFromPlanId).toBe(first.id);
      expect(reused.actor).toBe('webmcp');
      expect(reused.basedOnRevision).toBe(before.workspace.revision);
      expect(reused.solution).toBe(first.solution);
      expect(reused.solution.search).toBe(first.solution.search);
      expect(Reflect.set(reused, 'reusedFromPlanId', 'forged-source')).toBe(false);
      expect(Reflect.set(reused.solution.search, 'nodes', 0)).toBe(false);
      expect(first.actor).toBe('human');
      expect(first.reusedFromPlanId).toBeNull();
      expect(after.workspace).toBe(before.workspace);
      expect(after.selectedPlanId).toBe(reused.id);
      expect(after.approvedPlanId).toBe(first.id);
      expect(after.reviewPlanId).toBeNull();
      expect(after.plans).toEqual([first, reused]);
      expect(after.events).toHaveLength(before.events.length + 1);
      expect(after.events.at(-1)).toMatchObject({ actor: 'webmcp', action: 'Plan proposed' });
      expect(after.events.at(-1)!.id).not.toBe(before.events.at(-1)!.id);
      expect(after.events.at(-1)!.detail).toContain(reused.id);
      expect(after.events.at(-1)!.detail).toContain(first.id);
      expect(after.events.at(-1)!.detail).toContain('original computation');
      expect(after.events.at(-1)!.detail).toContain('no new solver search');
      expectCode(() => store.recordExport(reused.id, 'webmcp'), 'APPROVAL_REQUIRED');
      expectCode(() => store.approvePlan(reused.id), 'REVIEW_REQUIRED');
      expect(store.getSnapshot()).toBe(after);
      store.recordExport(first.id, 'webmcp');
      store.stagePlan(reused.id, before.workspace.revision);
      expect(store.approvePlan(reused.id)).toBe(reused);
      expect(store.getSnapshot().approvedPlanId).toBe(reused.id);
      expectCode(() => store.recordExport(first.id), 'APPROVAL_REQUIRED');
      expect(before.approvedPlanId).toBe(first.id);
    },
  );

  test('reordered additional sets reuse workspace-canonical exclusions without retaining caller arrays', () => {
    const store = createJob();
    const workspace = store.getSnapshot().workspace;
    const excluded = workspace.stock[0]!;
    const protectedBoard = workspace.stock.find((board) => board.locked)!;
    const inputExclusions = [protectedBoard.id, excluded.id];
    const reordered = [...inputExclusions].reverse();
    const first = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'least_stock',
      excludedStockIds: inputExclusions,
    });
    inputExclusions.push(workspace.stock[2]!.id);
    const reused = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'least_stock',
      excludedStockIds: reordered,
    });
    reordered.push(workspace.stock[1]!.id);
    expect(first.solution.complete).toBe(true);
    expect(first.solution.excludedStockIds).toEqual([excluded.id, protectedBoard.id]);
    expect(reused.reusedFromPlanId).toBe(first.id);
    expect(reused.solution).toBe(first.solution);
    expect(reused.solution.excludedStockIds).toEqual([excluded.id, protectedBoard.id]);
    expect(store.getSnapshot().workspace).toBe(workspace);
  });

  test('different objectives and declared additional sets miss even when protection makes constraints equal', () => {
    const store = createJob();
    const first = propose(store);
    for (const objective of ['fewest_boards', 'least_waste'] as const) {
      const differentObjective = propose(store, objective);
      expect(differentObjective.reusedFromPlanId).toBeNull();
      expect(differentObjective.solution).not.toBe(first.solution);
    }
    const workspace = store.getSnapshot().workspace;
    const protectedId = workspace.stock.find((board) => board.locked)!.id;
    const protectedOverlap = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'least_stock',
      excludedStockIds: [protectedId],
    });
    expect(protectedOverlap.reusedFromPlanId).toBeNull();
    expect(protectedOverlap.solution).not.toBe(first.solution);
    expect(protectedOverlap.solution.layouts).toEqual(first.solution.layouts);
    expect(protectedOverlap.solution.excludedStockIds).toEqual([protectedId]);
    expect(first.solution.excludedStockIds).toEqual([]);
    const differentExclusion = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'least_stock',
      excludedStockIds: [workspace.stock[0]!.id],
    });
    expect(differentExclusion.reusedFromPlanId).toBeNull();
    expect(differentExclusion.solution).not.toBe(first.solution);
    const repeatOverlap = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'least_stock',
      excludedStockIds: [protectedId],
    });
    expect(repeatOverlap.reusedFromPlanId).toBe(protectedOverlap.id);
    expect(repeatOverlap.solution).toBe(protectedOverlap.solution);
  });

  test('reverting measurements does not permit reuse across revisions', () => {
    const store = createJob();
    const first = propose(store);
    store.setSettings({ kerfMm: 4 });
    store.setSettings({ kerfMm: 3 });
    const recomputed = propose(store);
    expect(recomputed.basedOnRevision).toBe(first.basedOnRevision + 2);
    expect(recomputed.reusedFromPlanId).toBeNull();
    expect(recomputed.solution).not.toBe(first.solution);
    expect(recomputed.solution).toEqual(first.solution);
    expect(store.getSnapshot().plans).toEqual([first, recomputed]);
  });

  test('evicted records do not form a hidden cross-retention cache', () => {
    const store = createJob();
    const first = propose(store, 'least_waste');
    for (let index = 0; index < LIMITS.savedPlans; index++) propose(store, 'fewest_boards');
    expect(store.getSnapshot().plans.some((plan) => plan.id === first.id)).toBe(false);
    const recomputed = propose(store, 'least_waste');
    expect(recomputed.reusedFromPlanId).toBeNull();
    expect(recomputed.solution).not.toBe(first.solution);
    expect(store.getSnapshot().plans).toHaveLength(LIMITS.savedPlans);
  });

  test('checked partial solutions may be reused but cannot become a cut sheet', () => {
    const store = createJob();
    const workspace = store.getSnapshot().workspace;
    const excludedStockIds = workspace.stock
      .filter((board) => !board.locked)
      .map((board) => board.id);
    const first = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'least_stock',
      excludedStockIds,
    });
    const reused = store.proposePlan({
      expectedRevision: workspace.revision,
      objective: 'least_stock',
      excludedStockIds: [...excludedStockIds].reverse(),
    });
    expect(first.solution.complete).toBe(false);
    expect(reused.id).not.toBe(first.id);
    expect(reused.reusedFromPlanId).toBe(first.id);
    expect(reused.solution).toBe(first.solution);
    const before = store.getSnapshot();
    for (const call of [
      () => store.stagePlan(reused.id, workspace.revision),
      () => store.approvePlan(reused.id),
      () => store.recordExport(reused.id),
    ]) {
      expectCode(call, 'INCOMPLETE_PLAN');
      expect(store.getSnapshot()).toBe(before);
    }
  });

  test('a budget-exhausted partial and its reused identity remain unapproved and unreleasable', () => {
    const store = createJob();
    const priorApproved = propose(store);
    approve(store, priorApproved);
    const released = store.getSnapshot();
    store.clearWorkspace();
    store.updateProject({
      title: 'Bounded-search observed fixture',
      material: 'Uniform synthetic batch',
    });
    store.setSettings({ kerfMm: 3, minReusableMm: 400 });
    for (let index = 0; index < 14; index++) {
      store.addStock({ label: `Board ${index + 1}`, lengthMm: 2279, kind: 'board', locked: false });
    }
    for (const [index, lengthMm] of [
      300, 440, 580, 620, 710, 830, 950, 1020, 1140, 1270,
    ].entries()) {
      store.addRequirement({ label: `Part ${index + 1}`, lengthMm, quantity: 4 });
    }
    const workspace = store.getSnapshot().workspace;
    const first = propose(store);
    expect(first.basedOnRevision).toBe(workspace.revision);
    expect(first.reusedFromPlanId).toBeNull();
    expect(first.solution.complete).toBe(false);
    expect(first.solution.search).toMatchObject({
      nodes: 100_000,
      limit: 100_000,
      provenOptimal: false,
    });
    expect(first.solution.layouts.reduce((total, layout) => total + layout.cuts.length, 0)).toBe(
      38,
    );
    expect(first.solution.unfulfilled).toHaveLength(1);
    expect(first.solution.unfulfilled[0]).toMatchObject({
      requirementId: workspace.requirements[0]!.id,
      quantity: 2,
    });
    expect(first.solution.unfulfilled[0]!.reason).toContain('infeasibility is not proven');
    expect(store.getSnapshot().workspace).toBe(workspace);
    expect(store.getSnapshot().approvedPlanId).toBeNull();
    const reused = propose(store);
    expect(reused.id).not.toBe(first.id);
    expect(reused.id).not.toBe(priorApproved.id);
    expect(reused.basedOnRevision).toBe(workspace.revision);
    expect(reused.reusedFromPlanId).toBe(first.id);
    expect(reused.solution).toBe(first.solution);
    expect(reused.solution.search).toBe(first.solution.search);
    const guarded = store.getSnapshot();
    expect(guarded.workspace).toBe(workspace);
    expect(guarded.approvedPlanId).toBeNull();
    expect(guarded.reviewPlanId).toBeNull();
    for (const plan of [first, reused]) {
      for (const call of [
        () => store.stagePlan(plan.id, workspace.revision, 'webmcp'),
        () => store.approvePlan(plan.id),
        () => store.recordExport(plan.id, 'webmcp'),
      ]) {
        expectCode(call, 'INCOMPLETE_PLAN');
        expect(store.getSnapshot()).toBe(guarded);
      }
    }
    expect(released.approvedPlanId).toBe(priorApproved.id);
  });

  test('cache candidates never make duplicate, unknown or malformed additional exclusions acceptable', () => {
    const store = createJob();
    const workspace = store.getSnapshot().workspace;
    const knownId = workspace.stock[0]!.id;
    const request: PlanRequest = { expectedRevision: workspace.revision, objective: 'least_stock' };
    store.proposePlan(request);
    store.proposePlan({ ...request, excludedStockIds: [knownId] });
    const before = store.getSnapshot();
    const invalidExclusions: [unknown, string][] = [
      [[knownId, knownId], 'INVALID_EXCLUSIONS'],
      [[knownId, 'missing-stock'], 'UNKNOWN_STOCK'],
      [['missing-stock'], 'UNKNOWN_STOCK'],
      [[''], 'UNKNOWN_STOCK'],
      [[` ${knownId}`], 'UNKNOWN_STOCK'],
      [['x'.repeat(65)], 'UNKNOWN_STOCK'],
      [[1], 'INVALID_EXCLUSIONS'],
      [[null], 'INVALID_EXCLUSIONS'],
      [new Array(1), 'INVALID_EXCLUSIONS'],
      [Array.from({ length: LIMITS.stockBoards + 1 }, () => knownId), 'INVALID_EXCLUSIONS'],
      [null, 'INVALID_INPUT'],
      ['not-an-array', 'INVALID_INPUT'],
      [{}, 'INVALID_INPUT'],
    ];
    for (const [excludedStockIds, code] of invalidExclusions) {
      expectCode(
        () => store.proposePlan({ ...request, excludedStockIds: excludedStockIds as string[] }),
        code,
      );
      expect(store.getSnapshot()).toBe(before);
    }
  });

  test('request field, prototype, objective, actor and revision guards still precede reuse', () => {
    const store = createJob();
    const request: PlanRequest = {
      expectedRevision: store.getSnapshot().workspace.revision,
      objective: 'least_stock',
    };
    store.proposePlan(request);
    const before = store.getSnapshot();
    let accessorReads = 0;
    const accessorRequest = Object.defineProperty(
      { expectedRevision: request.expectedRevision },
      'objective',
      {
        enumerable: true,
        get() {
          accessorReads++;
          return request.objective;
        },
      },
    );
    const invalidRequests: [unknown, string][] = [
      [null, 'INVALID_INPUT'],
      [{ ...request, approved: true }, 'INVALID_INPUT'],
      [Object.assign(Object.create({ inherited: true }), request), 'INVALID_INPUT'],
      [accessorRequest, 'INVALID_INPUT'],
      [{ ...request, objective: 'toString' }, 'INVALID_OBJECTIVE'],
      [{ ...request, objective: null }, 'INVALID_OBJECTIVE'],
      [{ expectedRevision: request.expectedRevision }, 'INVALID_OBJECTIVE'],
      [{ ...request, expectedRevision: -1 }, 'INVALID_INPUT'],
      [{ ...request, expectedRevision: request.expectedRevision - 1 }, 'REVISION_CONFLICT'],
      [{ ...request, expectedRevision: request.expectedRevision + 1 }, 'REVISION_CONFLICT'],
    ];
    for (const [input, code] of invalidRequests) {
      expectCode(() => store.proposePlan(input as PlanRequest), code);
      expect(store.getSnapshot()).toBe(before);
    }
    expect(accessorReads).toBe(0);
    expectCode(() => store.proposePlan(request, 'agent' as Actor), 'INVALID_INPUT');
    expect(store.getSnapshot()).toBe(before);
  });
});

describe('immutable published state', () => {
  test('nested measurement, plan, activity and approval mutations cannot alter a snapshot', () => {
    const store = createJob();
    const plan = propose(store);
    approve(store, plan);
    const snapshot = store.getSnapshot();
    const original = structuredClone(snapshot);
    const layout = plan.solution.layouts[0]!;
    const mutations: [object, string, unknown][] = [
      [snapshot, 'approvedPlanId', 'forged-plan'],
      [snapshot, 'pendingMeasurements', true],
      [snapshot.workspace, 'revision', snapshot.workspace.revision + 100],
      [snapshot.workspace.stock[0]!, 'lengthMm', 1],
      [snapshot.workspace.stock.find((board) => board.locked)!, 'locked', false],
      [snapshot.workspace.requirements[0]!, 'quantity', 40],
      [snapshot.workspace.settings, 'kerfMm', 0],
      [plan, 'id', 'forged-plan'],
      [plan, 'reusedFromPlanId', 'forged-source'],
      [plan, 'basedOnRevision', snapshot.workspace.revision + 1],
      [plan.solution, 'complete', false],
      [plan.solution.metrics, 'stockUsedMm', 1],
      [plan.solution.search, 'provenOptimal', false],
      [layout, 'stockLengthMm', 100_000],
      [layout.cuts[0]!, 'lengthMm', 1],
      [snapshot.events.at(-1)!, 'actor', 'webmcp'],
      [snapshot.bridge, 'message', 'Forged native registration'],
    ];
    for (const [target, field, value] of mutations)
      expect(Reflect.set(target, field, value)).toBe(false);
    expect(Reflect.deleteProperty(snapshot.workspace.stock[0]!, 'locked')).toBe(false);
    expect(() => snapshot.plans.push(plan)).toThrow(TypeError);
    expect(() => snapshot.workspace.stock.pop()).toThrow(TypeError);
    expect(() => layout.cuts.pop()).toThrow(TypeError);
    expect(() => plan.solution.excludedStockIds.push(snapshot.workspace.stock[0]!.id)).toThrow(
      TypeError,
    );
    expect(snapshot).toEqual(original);
    expect(store.getSnapshot()).toBe(snapshot);
    store.updateStock(snapshot.workspace.stock[0]!.id, { lengthMm: 701 });
    expect(store.getSnapshot().workspace.stock[0]!.lengthMm).toBe(701);
    expect(snapshot).toEqual(original);
    expect(store.getSnapshot().approvedPlanId).toBeNull();
  });

  test('later changes to caller-owned human inputs cannot rewrite recorded measurements', () => {
    const store = createJob();
    const project = { title: 'Committed title' };
    const stock = {
      label: 'Committed offcut',
      lengthMm: 500,
      kind: 'offcut' as const,
      locked: true,
    };
    const requirement = { label: 'Committed brace', lengthMm: 100, quantity: 1 };
    const settings = { kerfMm: 4, minReusableMm: 101 };
    store.updateProject(project);
    store.addStock(stock);
    store.addRequirement(requirement);
    store.setSettings(settings);
    const committed = store.getSnapshot();
    project.title = 'Uncommitted title';
    stock.lengthMm = 1;
    stock.locked = false;
    requirement.quantity = 40;
    settings.kerfMm = 0;
    expect(store.getSnapshot()).toBe(committed);
    expect(committed.workspace.title).toBe('Committed title');
    expect(committed.workspace.stock.at(-1)).toMatchObject({ lengthMm: 500, locked: true });
    expect(committed.workspace.requirements.at(-1)).toMatchObject({ quantity: 1 });
    expect(committed.workspace.settings).toEqual({ kerfMm: 4, minReusableMm: 101 });
  });
});

type MeasurementEnvelope = { version: number; workspace: Omit<Workspace, 'revision'> };
type Corruption = {
  name: string;
  serialize(valid: MeasurementEnvelope, session: WorkshopSnapshot): string;
};

const corruptions: Corruption[] = [
  { name: 'broken JSON', serialize: () => '{not-json' },
  { name: 'null envelope', serialize: () => 'null' },
  { name: 'unsupported version', serialize: (valid) => JSON.stringify({ ...valid, version: 2 }) },
  { name: 'missing version', serialize: (valid) => JSON.stringify({ workspace: valid.workspace }) },
  { name: 'missing measurements', serialize: () => JSON.stringify({ version: 1 }) },
  {
    name: 'session pending-measurement flag',
    serialize: (valid) => JSON.stringify({ ...valid, pendingMeasurements: true }),
  },
  {
    name: 'nested pending-measurement flag',
    serialize: (valid) =>
      JSON.stringify({ ...valid, workspace: { ...valid.workspace, pendingMeasurements: true } }),
  },
  {
    name: 'session approval, plans and history',
    serialize: (valid, session) =>
      JSON.stringify({
        ...valid,
        approvedPlanId: session.approvedPlanId,
        reviewPlanId: session.reviewPlanId,
        plans: session.plans,
        events: session.events,
      }),
  },
  {
    name: 'nested session revision',
    serialize: (valid) =>
      JSON.stringify({ ...valid, workspace: { ...valid.workspace, revision: 900 } }),
  },
  {
    name: 'prototype-shaped envelope field',
    serialize: (valid, session) =>
      JSON.stringify({ ...valid, ['__proto__']: { approvedPlanId: session.approvedPlanId } }),
  },
  {
    name: 'non-array stock',
    serialize: (valid) =>
      JSON.stringify({ ...valid, workspace: { ...valid.workspace, stock: {} } }),
  },
  {
    name: 'invalid board measurement',
    serialize: (valid) =>
      JSON.stringify({
        ...valid,
        workspace: {
          ...valid.workspace,
          stock: valid.workspace.stock.map((board, index) =>
            index === 0 ? { ...board, lengthMm: 0 } : board,
          ),
        },
      }),
  },
  {
    name: 'duplicate board identity',
    serialize: (valid) =>
      JSON.stringify({
        ...valid,
        workspace: {
          ...valid.workspace,
          stock: [...valid.workspace.stock, valid.workspace.stock[0]],
        },
      }),
  },
  {
    name: 'non-boolean protection',
    serialize: (valid) =>
      JSON.stringify({
        ...valid,
        workspace: {
          ...valid.workspace,
          stock: valid.workspace.stock.map((board, index) =>
            index === 0 ? { ...board, locked: 'false' } : board,
          ),
        },
      }),
  },
  {
    name: 'unsupported stock property',
    serialize: (valid) =>
      JSON.stringify({
        ...valid,
        workspace: {
          ...valid.workspace,
          stock: valid.workspace.stock.map((board, index) =>
            index === 0 ? { ...board, actor: 'human' } : board,
          ),
        },
      }),
  },
  {
    name: 'missing requirement quantity',
    serialize: (valid) =>
      JSON.stringify({
        ...valid,
        workspace: {
          ...valid.workspace,
          requirements: [
            { id: valid.workspace.requirements[0]!.id, label: 'Shelf', lengthMm: 600 },
          ],
        },
      }),
  },
  {
    name: 'unsupported requirement property',
    serialize: (valid) =>
      JSON.stringify({
        ...valid,
        workspace: {
          ...valid.workspace,
          requirements: valid.workspace.requirements.map((part) => ({ ...part, approved: true })),
        },
      }),
  },
  {
    name: 'fractional saw kerf',
    serialize: (valid) =>
      JSON.stringify({
        ...valid,
        workspace: { ...valid.workspace, settings: { ...valid.workspace.settings, kerfMm: 1.5 } },
      }),
  },
  {
    name: 'missing reusable threshold',
    serialize: (valid) =>
      JSON.stringify({ ...valid, workspace: { ...valid.workspace, settings: { kerfMm: 3 } } }),
  },
];

describe('versioned measurement-only persistence', () => {
  test('the actual JSON envelope round-trips measurements, never plans, decisions or activity', () => {
    const storage = memoryStorage();
    const store = createJob(storage);
    const savedBeforePlanning = storage.getItem(STORAGE_KEY)!;
    const { approved, reviewing } = approvedAndReviewing(store);
    store.setPendingMeasurements(true);
    store.recordExport(approved.id, 'webmcp');
    store.updateProject({ title: store.getSnapshot().workspace.title });
    const session = store.getSnapshot();
    expect(storage.getItem(STORAGE_KEY)).toBe(savedBeforePlanning);
    expect(JSON.parse(savedBeforePlanning)).toEqual({
      version: 1,
      workspace: measurements(session.workspace),
    });
    const restoredStore = createWorkshopStore(storage);
    const restored = restoredStore.getSnapshot();
    expect(restored.workspace).toEqual({ ...measurements(session.workspace), revision: 0 });
    expectNoRestoredSession(restored, session);
    expect(restored.notice).toContain('Saved measurements were loaded');
    expect(restored.notice).toContain('No plans, approvals, or agent history were restored');
    expect(restored.events.some((event) => event.action === 'Saved measurements loaded')).toBe(
      true,
    );
    restoredStore.updateStock(restored.workspace.stock[0]!.id, { lengthMm: 702 });
    expect(restoredStore.getSnapshot().workspace.revision).toBe(1);
    expect(store.getSnapshot()).toBe(session);
    expect(session.approvedPlanId).toBe(approved.id);
    expect(session.reviewPlanId).toBe(reviewing.id);
    expect(session.workspace.stock[0]!.lengthMm).toBe(700);
    expect(session.pendingMeasurements).toBe(true);
  });

  test.each(corruptions)(
    '$name is visibly rejected without importing state or erasing saved data',
    ({ serialize }) => {
      const storage = memoryStorage();
      const original = createJob(storage);
      approvedAndReviewing(original);
      const session = original.getSnapshot();
      const valid = JSON.parse(storage.getItem(STORAGE_KEY)!) as MeasurementEnvelope;
      const corrupted = serialize(valid, session);
      storage.setItem(STORAGE_KEY, corrupted);
      const store = createWorkshopStore(storage);
      const rejected = store.getSnapshot();
      expect(rejected.workspace).toEqual(createSampleWorkspace());
      expectNoRestoredSession(rejected, session);
      expect(rejected.notice).toContain('Saved measurements were rejected');
      expect(rejected.notice).toContain('not loaded');
      expect(rejected.events.some((event) => event.action === 'Saved measurements rejected')).toBe(
        true,
      );
      expect(storage.getItem(STORAGE_KEY)).toBe(corrupted);
      store.updateProject({ title: 'Human replacement after rejection' });
      expect(store.getSnapshot().workspace.revision).toBe(1);
      expect(store.getSnapshot().notice).toContain('Current measurements are now saved locally');
      expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({
        version: 1,
        workspace: measurements(store.getSnapshot().workspace),
      });
      expect(store.getSnapshot().plans).toEqual([]);
      expect(store.getSnapshot().approvedPlanId).toBeNull();
    },
  );

  test.each([
    {
      field: 'stock',
      limit: LIMITS.stockBoards,
      message: 'Saved stock must contain at most 24 boards.',
    },
    {
      field: 'requirements',
      limit: LIMITS.requirements,
      message: 'Saved requirements must contain at most 16 distinct entries.',
    },
  ] as const)(
    'over-limit saved $field reject before any row descriptor walk without touching storage',
    ({ field, limit, message }) => {
      const storage = memoryStorage();
      const serialized = JSON.stringify({
        version: 1,
        workspace: {
          ...measurements(createSampleWorkspace()),
          stock: [{ unsupported: true }],
          requirements: [{ unsupported: true }],
          [field]: Array.from({ length: limit + 1 }, () => ({ unsupported: true })),
        },
      });
      storage.setItem(STORAGE_KEY, serialized);
      storage.failWrites = true;
      const writeAttempts = storage.writeAttempts;
      const store = createWorkshopStore(storage);
      const rejected = store.getSnapshot();
      expect(rejected.workspace).toEqual(createSampleWorkspace());
      expect(rejected.pendingMeasurements).toBe(false);
      expect(rejected.notice).toContain('Saved measurements were rejected');
      expect(rejected.notice).toContain(message);
      expect(
        rejected.events.find((event) => event.action === 'Saved measurements rejected')!.detail,
      ).toContain(message);
      expect(storage.getItem(STORAGE_KEY)).toBe(serialized);
      expect(storage.writeAttempts).toBe(writeAttempts);
      store.updateProject({ title: rejected.workspace.title });
      store.setSettings({ ...rejected.workspace.settings });
      expect(store.getSnapshot()).toBe(rejected);
      expect(storage.getItem(STORAGE_KEY)).toBe(serialized);
      expect(storage.writeAttempts).toBe(writeAttempts);
    },
  );

  test('valid saved arrays at the 24-board and 16-requirement boundaries still restore', () => {
    const storage = memoryStorage();
    const recorded: Omit<Workspace, 'revision'> = {
      ...measurements(createSampleWorkspace()),
      stock: Array.from({ length: 24 }, (_, index) => ({
        id: `stock-${index}`,
        label: `Board ${index + 1}`,
        lengthMm: 1000,
        kind: 'board' as const,
        locked: false,
      })),
      requirements: Array.from({ length: 16 }, (_, index) => ({
        id: `part-${index}`,
        label: `Part ${index + 1}`,
        lengthMm: 100,
        quantity: 1,
      })),
    };
    const serialized = JSON.stringify({ version: 1, workspace: recorded });
    storage.setItem(STORAGE_KEY, serialized);
    const writeAttempts = storage.writeAttempts;
    const restored = createWorkshopStore(storage).getSnapshot();
    expect(restored.workspace).toEqual({ ...recorded, revision: 0 });
    expect(restored.pendingMeasurements).toBe(false);
    expect(restored.plans).toEqual([]);
    expect(restored.approvedPlanId).toBeNull();
    expect(restored.reviewPlanId).toBeNull();
    expect(restored.notice).toContain('Saved measurements were loaded');
    expect(storage.getItem(STORAGE_KEY)).toBe(serialized);
    expect(storage.writeAttempts).toBe(writeAttempts);
  });

  test('unreadable storage leaves data intact, reports the failure, and can save a later human replacement', () => {
    const storage = memoryStorage();
    const original = createJob(storage);
    approvedAndReviewing(original);
    const session = original.getSnapshot();
    const oldSaved = storage.values.get(STORAGE_KEY);
    storage.failReads = true;
    const store = createWorkshopStore(storage);
    const unreadable = store.getSnapshot();
    expect(unreadable.workspace).toEqual(createSampleWorkspace());
    expectNoRestoredSession(unreadable, session);
    expect(unreadable.notice).toContain('could not be read');
    expect(unreadable.notice).toContain('Storage access denied');
    expect(
      unreadable.events.some((event) => event.action === 'Saved measurements unreadable'),
    ).toBe(true);
    expect(storage.values.get(STORAGE_KEY)).toBe(oldSaved);
    store.updateProject({ title: 'Human replacement after read failure' });
    storage.failReads = false;
    expect(store.getSnapshot().notice).toContain('Current measurements are now saved locally');
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({
      version: 1,
      workspace: measurements(store.getSnapshot().workspace),
    });
  });

  test('a failed write keeps real edits in-session, invalidates decisions and warns that stored measurements are older', () => {
    const storage = memoryStorage();
    const store = createJob(storage);
    approvedAndReviewing(store);
    store.setPendingMeasurements(true);
    const before = store.getSnapshot();
    const oldSaved = storage.getItem(STORAGE_KEY)!;
    storage.failWrites = true;
    store.updateStock(before.workspace.stock[0]!.id, { lengthMm: 703 });
    const unsaved = store.getSnapshot();
    expect(unsaved.workspace.stock[0]!.lengthMm).toBe(703);
    expect(unsaved.workspace.revision).toBe(before.workspace.revision + 1);
    expect(unsaved.pendingMeasurements).toBe(true);
    expect(unsaved.reviewPlanId).toBeNull();
    expect(unsaved.approvedPlanId).toBeNull();
    expect(unsaved.notice).toContain('could not be saved');
    expect(unsaved.notice).toContain('Storage quota exhausted');
    expect(unsaved.notice).toContain('previously saved measurements may be older');
    expect(unsaved.events.at(-1)).toMatchObject({
      actor: 'system',
      action: 'Local measurement save failed',
    });
    expect(storage.getItem(STORAGE_KEY)).toBe(oldSaved);
    const failedWriteAttempts = storage.writeAttempts;
    store.updateStock(unsaved.workspace.stock[0]!.id, { lengthMm: 703 });
    store.updateProject({});
    store.setSettings({ ...unsaved.workspace.settings });
    expect(store.getSnapshot()).toBe(unsaved);
    expect(storage.writeAttempts).toBe(failedWriteAttempts);
    const reopened = createWorkshopStore(storage).getSnapshot();
    expect(reopened.workspace).toEqual({ ...measurements(before.workspace), revision: 0 });
    expectNoRestoredSession(reopened, before);
    storage.failWrites = false;
    store.setSettings({ kerfMm: unsaved.workspace.settings.kerfMm });
    expect(store.getSnapshot()).toBe(unsaved);
    expect(storage.writeAttempts).toBe(failedWriteAttempts);
    store.updateProject({ title: 'Saved after quota recovery' });
    expect(store.getSnapshot().notice).toContain('Current measurements are now saved locally');
    expect(store.getSnapshot().events.at(-1)).toMatchObject({
      actor: 'system',
      action: 'Local measurements saved',
    });
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({
      version: 1,
      workspace: measurements(store.getSnapshot().workspace),
    });
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).workspace.stock[0].lengthMm).toBe(703);
  });

  test('explicitly disabled saving remains visible while the real manual planning flow still works', () => {
    const store = createWorkshopStore(null);
    expect(store.getSnapshot().notice).toContain('Local saving is disabled');
    store.updateProject({ title: 'Session-only human project' });
    expect(store.getSnapshot().notice).toContain('measurements remain in this page only');
    const plan = propose(store);
    approve(store, plan);
    store.recordExport(plan.id);
    expect(store.getSnapshot().approvedPlanId).toBe(plan.id);
    expect(store.getSnapshot().notice).toContain('measurements remain in this page only');
  });

  test('clearing and resetting replace only saved measurements, not the new session history', () => {
    const storage = memoryStorage();
    const store = createJob(storage);
    approvedAndReviewing(store);
    store.clearWorkspace();
    const cleared = store.getSnapshot();
    const reopenedEmpty = createWorkshopStore(storage).getSnapshot();
    expect(reopenedEmpty.workspace.stock).toEqual([]);
    expect(reopenedEmpty.workspace.requirements).toEqual([]);
    expectNoRestoredSession(reopenedEmpty, cleared);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({
      version: 1,
      workspace: measurements(cleared.workspace),
    });
    store.resetSample();
    const reset = store.getSnapshot();
    expect(reset.workspace.revision).toBe(cleared.workspace.revision + 1);
    expect(createWorkshopStore(storage).getSnapshot().workspace).toEqual(createSampleWorkspace());
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({
      version: 1,
      workspace: measurements(reset.workspace),
    });
  });
});
