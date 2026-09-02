import { describe, expect, test } from 'bun:test';
import { WorkshopError } from './errors';
import { createSampleWorkspace } from './sample';
import { LIMITS } from './types';
import type { Objective, PlanRecord, WorkshopSnapshot, WorkshopStore, Workspace } from './types';
import { createWorkshopStore } from './workshop-store';

const STORAGE_KEY = 'offcut.measurements.v1';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    failReads: false,
    failWrites: false,
    getItem(key: string) {
      if (this.failReads) throw new Error('Storage access denied');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
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
  test('equal and empty edits leave the live review, approval and snapshot untouched', () => {
    const store = createJob();
    approvedAndReviewing(store);
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
    }
  });

  test.each(humanEdits)(
    '$name changes revise once and invalidate both release decisions',
    ({ apply }) => {
      const store = createJob();
      const { approved, reviewing } = approvedAndReviewing(store);
      const before = store.getSnapshot();
      apply(store, before.workspace);
      const after = store.getSnapshot();
      expect(after.workspace.revision).toBe(before.workspace.revision + 1);
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
      const before = store.getSnapshot();
      store[operation]();
      const replaced = store.getSnapshot();
      expect(replaced.workspace.revision).toBe(before.workspace.revision + 1);
      expect(replaced.plans).toEqual([]);
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
      [snapshot.workspace, 'revision', snapshot.workspace.revision + 100],
      [snapshot.workspace.stock[0]!, 'lengthMm', 1],
      [snapshot.workspace.stock.find((board) => board.locked)!, 'locked', false],
      [snapshot.workspace.requirements[0]!, 'quantity', 40],
      [snapshot.workspace.settings, 'kerfMm', 0],
      [plan, 'id', 'forged-plan'],
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
    const before = store.getSnapshot();
    const oldSaved = storage.getItem(STORAGE_KEY)!;
    storage.failWrites = true;
    store.updateStock(before.workspace.stock[0]!.id, { lengthMm: 703 });
    const unsaved = store.getSnapshot();
    expect(unsaved.workspace.stock[0]!.lengthMm).toBe(703);
    expect(unsaved.workspace.revision).toBe(before.workspace.revision + 1);
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
    const reopened = createWorkshopStore(storage).getSnapshot();
    expect(reopened.workspace).toEqual({ ...measurements(before.workspace), revision: 0 });
    expectNoRestoredSession(reopened, before);
    storage.failWrites = false;
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
