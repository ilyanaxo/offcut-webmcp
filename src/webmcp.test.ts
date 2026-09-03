import { describe, expect, test } from 'bun:test';
import { LIMITS } from './types';
import type { Objective, PlanRecord, WorkshopSnapshot, WorkshopStore } from './types';
import { createToolDefinitions } from './webmcp';
import type { OffcutTool } from './webmcp';
import { createWorkshopStore } from './workshop-store';

const TOOL_NAMES = [
  'get_workshop',
  'plan_cuts',
  'inspect_plan',
  'compare_plans',
  'stage_plan_for_review',
  'export_cut_list',
] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type ToolResult = Record<string, unknown> & {
  ok: boolean;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

function createJob(): WorkshopStore {
  const store = createWorkshopStore(null);
  store.clearWorkspace();
  store.setSettings({ kerfMm: 3, minReusableMm: 100 });
  store.addStock({ label: 'Short board one', lengthMm: 700, kind: 'board', locked: false });
  store.addStock({ label: 'Short board two', lengthMm: 700, kind: 'offcut', locked: false });
  store.addStock({ label: 'Long board', lengthMm: 1500, kind: 'board', locked: false });
  store.addStock({ label: 'Human protected reserve', lengthMm: 1500, kind: 'board', locked: true });
  store.addRequirement({ label: 'Shelf', lengthMm: 600, quantity: 2 });
  return store;
}

// Exercise the actual callbacks with JSON data, without consulting their schemas or registering a fake browser API.
function invoke(
  tools: OffcutTool[],
  name: ToolName,
  input: unknown,
  signal?: AbortSignal,
): ToolResult {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing actual tool ${name}`);
  const jsonInput: unknown = JSON.parse(JSON.stringify(input));
  const result =
    signal === undefined ? tool.execute(jsonInput) : tool.execute(jsonInput, { signal });
  expect(result).not.toBeNull();
  expect(typeof result).toBe('object');
  expect(typeof (result as ToolResult).ok).toBe('boolean');
  return result as ToolResult;
}

function nativePlan(
  store: WorkshopStore,
  tools: OffcutTool[],
  objective: Objective,
  excludedStockIds?: string[],
): PlanRecord {
  const revision = store.getSnapshot().workspace.revision;
  const result = invoke(tools, 'plan_cuts', {
    expectedRevision: revision,
    objective,
    excludedStockIds,
  });
  expect(result).toMatchObject({
    ok: true,
    plan: { actor: 'webmcp', basedOnRevision: revision, solution: { objective } },
  });
  const id = (result.plan as PlanRecord).id;
  const plan = store.getSnapshot().plans.find((candidate) => candidate.id === id);
  expect(plan).toBeDefined();
  expect((result.plan as PlanRecord).solution).toEqual(plan!.solution);
  expect(result.plan).toMatchObject({
    reusedFromPlanId: plan!.reusedFromPlanId,
    pendingMeasurements: store.getSnapshot().pendingMeasurements,
    approved: false,
    canRequestReview: plan!.solution.complete && !store.getSnapshot().pendingMeasurements,
  });
  return plan!;
}

function createSession() {
  const store = createJob();
  const tools = createToolDefinitions(store);
  const first = nativePlan(store, tools, 'least_stock');
  const second = nativePlan(store, tools, 'fewest_boards');
  return { store, tools, first, second };
}

function validInput(
  name: ToolName,
  snapshot: WorkshopSnapshot,
  first: PlanRecord,
  second: PlanRecord,
): Record<string, unknown> {
  switch (name) {
    case 'get_workshop':
      return {};
    case 'plan_cuts':
      return { expectedRevision: snapshot.workspace.revision, objective: 'least_stock' };
    case 'inspect_plan':
    case 'export_cut_list':
      return { planId: first.id };
    case 'compare_plans':
      return { planIds: [first.id, second.id] };
    case 'stage_plan_for_review':
      return { planId: first.id, expectedRevision: snapshot.workspace.revision };
  }
}

function expectRejected(
  store: WorkshopStore,
  tools: OffcutTool[],
  name: ToolName,
  input: unknown,
  code: string,
  signal?: AbortSignal,
): ToolResult {
  const before = store.getSnapshot();
  const result = invoke(tools, name, input, signal);
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(typeof result.error?.message).toBe('string');
  expect(result.error!.message.length).toBeGreaterThan(0);
  const after = store.getSnapshot();
  expect(after.workspace).toBe(before.workspace);
  expect(after.pendingMeasurements).toBe(before.pendingMeasurements);
  expect(after.plans).toBe(before.plans);
  expect(after.selectedPlanId).toBe(before.selectedPlanId);
  expect(after.reviewPlanId).toBe(before.reviewPlanId);
  expect(after.approvedPlanId).toBe(before.approvedPlanId);
  expect(after.events).toHaveLength(before.events.length + 1);
  expect(after.events.at(-1)).toMatchObject({ actor: 'webmcp', action: `${name} · rejected` });
  expect(after.events.at(-1)!.detail).toBe(`${code}: ${result.error!.message}`);
  return result;
}

// Follow the exporter tests' quoted-cell reader, consuming every byte and escaped quote.
function csvRows(csv: string): string[][] {
  const cell = /"((?:[^"]|"")*)"(,|\r\n)/gy;
  const rows: string[][] = [];
  let row: string[] = [];
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = cell.exec(csv)) !== null) {
    row.push(match[1]!.replaceAll('""', '"'));
    consumed = cell.lastIndex;
    if (match[2] === '\r\n') {
      rows.push(row);
      row = [];
    }
  }
  expect(consumed).toBe(csv.length);
  expect(row).toEqual([]);
  return rows;
}

describe('actual native planning, inspection, comparison and release', () => {
  test('all six tools preserve human physical constraints and only a human approval releases the exact plan', () => {
    const store = createJob();
    const tools = createToolDefinitions(store);
    const physical = store.getSnapshot().workspace;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: !['plan_cuts', 'stage_plan_for_review'].includes(tool.name),
        untrustedContentHint: true,
      });
    }
    const workshop = invoke(tools, 'get_workshop', {});
    expect(workshop).toMatchObject({
      ok: true,
      workspace: physical,
      pendingMeasurements: false,
      totalRequiredParts: 2,
      requiredPartsMm: 1200,
    });
    expect(workshop.protectedStockIds).toEqual([physical.stock[3]!.id]);
    expect(store.getSnapshot().events.at(-1)).toMatchObject({
      actor: 'webmcp',
      action: 'get_workshop',
    });
    expect(store.getSnapshot().approvedPlanId).toBeNull();

    const first = nativePlan(store, tools, 'least_stock');
    expect(first.solution.metrics).toMatchObject({
      stockUsedMm: 1400,
      boardCount: 2,
      partsMm: 1200,
      kerfMm: 6,
      scrapMm: 194,
      reusableMm: 0,
    });
    expect(store.getSnapshot().approvedPlanId).toBeNull();
    const second = nativePlan(store, tools, 'fewest_boards');
    expect(second.solution.metrics).toMatchObject({
      stockUsedMm: 1500,
      boardCount: 1,
      partsMm: 1200,
      kerfMm: 6,
      scrapMm: 0,
      reusableMm: 294,
    });
    expect(store.getSnapshot().approvedPlanId).toBeNull();
    for (const plan of [first, second]) {
      expect(plan.solution.complete).toBe(true);
      expect(plan.solution.layouts.some((layout) => layout.stockId === physical.stock[3]!.id)).toBe(
        false,
      );
    }
    const inspection = invoke(tools, 'inspect_plan', { planId: first.id });
    expect(inspection).toMatchObject({
      ok: true,
      plan: {
        id: first.id,
        solution: first.solution,
        reusedFromPlanId: null,
        pendingMeasurements: false,
        fresh: true,
        approved: false,
        awaitingHumanApproval: false,
        canRequestReview: true,
        wasteMm: 200,
      },
    });
    expect(store.getSnapshot().approvedPlanId).toBeNull();

    const comparison = invoke(tools, 'compare_plans', { planIds: [first.id, second.id] });
    expect(comparison).toMatchObject({
      ok: true,
      revision: physical.revision,
      baselinePlanId: first.id,
      protectedStockIds: [physical.stock[3]!.id],
      sameConstraints: true,
    });
    const rows = comparison.plans as {
      id: string;
      deltaFromFirst: {
        stockUsedMm: number;
        boardCount: number;
        wasteMm: number;
        reusableMm: number;
        utilizationPercentagePoints: number;
      };
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: first.id,
      reusedFromPlanId: null,
      excludedStockIds: [],
      sameConstraintsAsFirst: true,
      deltaFromFirst: {
        stockUsedMm: 0,
        boardCount: 0,
        wasteMm: 0,
        reusableMm: 0,
        utilizationPercentagePoints: 0,
      },
    });
    expect(rows[1]).toMatchObject({
      id: second.id,
      reusedFromPlanId: null,
      excludedStockIds: [],
      sameConstraintsAsFirst: true,
      deltaFromFirst: { stockUsedMm: 100, boardCount: -1, wasteMm: -194, reusableMm: 294 },
    });
    expect(rows[1]!.deltaFromFirst.utilizationPercentagePoints).toBeCloseTo(
      (1200 / 1500 - 1200 / 1400) * 100,
      10,
    );
    expect(store.getSnapshot().approvedPlanId).toBeNull();

    const stage = invoke(tools, 'stage_plan_for_review', {
      planId: first.id,
      expectedRevision: physical.revision,
    });
    expect(stage).toMatchObject({
      ok: true,
      status: 'awaiting_human_approval',
      plan: { id: first.id, awaitingHumanApproval: true, approved: false },
    });
    expect(store.getSnapshot()).toMatchObject({
      reviewPlanId: first.id,
      selectedPlanId: first.id,
      approvedPlanId: null,
    });
    expectRejected(store, tools, 'export_cut_list', { planId: first.id }, 'APPROVAL_REQUIRED');
    expect(store.getSnapshot().workspace).toBe(physical);

    store.approvePlan(first.id);
    expect(store.getSnapshot().events.at(-1)).toMatchObject({
      actor: 'human',
      action: 'Plan approved',
    });
    const approvedInspection = invoke(tools, 'inspect_plan', { planId: first.id });
    expect(approvedInspection).toMatchObject({
      ok: true,
      plan: { id: first.id, approved: true, awaitingHumanApproval: false },
    });
    const draft = nativePlan(store, tools, 'least_waste');
    expect(store.getSnapshot()).toMatchObject({
      approvedPlanId: first.id,
      selectedPlanId: draft.id,
    });
    const exported = invoke(tools, 'export_cut_list', { planId: first.id });
    expect(exported).toMatchObject({
      ok: true,
      planId: first.id,
      revision: physical.revision,
      mimeType: 'text/csv;charset=utf-8',
      filename: `offcut-my-next-project-r${physical.revision}-${first.id}.csv`,
    });
    expect(exported.csv as string).toContain(`"${first.id}"`);
    expect(exported.csv as string).not.toContain(`"${draft.id}"`);
    const [firstHeader, ...firstCsvRows] = csvRows(exported.csv as string);
    expect(firstHeader).toHaveLength(17);
    expect(firstHeader![8]).toBe('Part ID');
    expect(firstCsvRows).toHaveLength(2);
    for (const row of firstCsvRows) {
      expect(row).toHaveLength(17);
      expect(row[2]).toBe(first.id);
      expect(row[8]).toBe(physical.requirements[0]!.id);
      expect(row[9]).toBe(physical.requirements[0]!.label);
    }
    expect(store.getSnapshot().events.at(-1)).toMatchObject({
      actor: 'webmcp',
      action: 'Approved cut sheet exported',
    });
    expectRejected(store, tools, 'export_cut_list', { planId: draft.id }, 'APPROVAL_REQUIRED');
    expect(store.getSnapshot().workspace).toBe(physical);
    expect(store.getSnapshot().approvedPlanId).toBe(first.id);

    expect(
      invoke(tools, 'stage_plan_for_review', {
        planId: second.id,
        expectedRevision: physical.revision,
      }),
    ).toMatchObject({ ok: true, status: 'awaiting_human_approval' });
    store.approvePlan(second.id);
    const secondExport = invoke(tools, 'export_cut_list', { planId: second.id });
    expect(secondExport).toMatchObject({
      ok: true,
      planId: second.id,
      filename: `offcut-my-next-project-r${physical.revision}-${second.id}.csv`,
    });
    expect(secondExport.filename).not.toBe(exported.filename);
    const [, ...secondCsvRows] = csvRows(secondExport.csv as string);
    expect(secondCsvRows).toHaveLength(2);
    expect(new Set(firstCsvRows.map((row) => row[4])).size).toBe(2);
    expect(new Set(secondCsvRows.map((row) => row[4])).size).toBe(1);
    expect(secondCsvRows.every((row) => row[2] === second.id)).toBe(true);
    expectRejected(store, tools, 'export_cut_list', { planId: first.id }, 'APPROVAL_REQUIRED');
    expect(store.getSnapshot().workspace).toBe(physical);
  });

  test('additional exclusions only reserve more stock, and an actual incomplete native plan cannot enter review', () => {
    const store = createJob();
    const tools = createToolDefinitions(store);
    const physical = store.getSnapshot().workspace;
    const exclusions = [physical.stock[0]!.id, physical.stock[3]!.id];
    const complete = nativePlan(store, tools, 'least_stock', exclusions);
    expect(complete.solution.excludedStockIds).toEqual(exclusions);
    expect(complete.solution.complete).toBe(true);
    expect(complete.solution.layouts.map((layout) => layout.stockId)).toEqual([
      physical.stock[2]!.id,
    ]);
    const incomplete = nativePlan(
      store,
      tools,
      'least_stock',
      physical.stock.filter((board) => !board.locked).map((board) => board.id),
    );
    expect(incomplete.solution.complete).toBe(false);
    expect(incomplete.solution.layouts).toEqual([]);
    expect(incomplete.solution.unfulfilled).toMatchObject([
      { requirementId: physical.requirements[0]!.id, quantity: 2 },
    ]);
    store.setPendingMeasurements(true);
    const inspection = invoke(tools, 'inspect_plan', { planId: incomplete.id });
    expect(inspection).toMatchObject({
      ok: true,
      plan: { fresh: true, pendingMeasurements: true, canRequestReview: false, approved: false },
    });
    expectRejected(
      store,
      tools,
      'stage_plan_for_review',
      { planId: incomplete.id, expectedRevision: physical.revision },
      'INCOMPLETE_PLAN',
    );
    expectRejected(
      store,
      tools,
      'compare_plans',
      { planIds: [complete.id, incomplete.id] },
      'INCOMPLETE_PLAN',
    );
    expectRejected(store, tools, 'export_cut_list', { planId: incomplete.id }, 'INCOMPLETE_PLAN');
    expect(store.getSnapshot().workspace).toBe(physical);
    expect(store.getSnapshot().approvedPlanId).toBeNull();
  });

  test('effective comparisons retain declared additional exclusions and allow honest different-constraint what-ifs', () => {
    const store = createJob();
    const tools = createToolDefinitions(store);
    const workspace = store.getSnapshot().workspace;
    const protectedId = workspace.stock[3]!.id;
    const first = nativePlan(store, tools, 'least_stock');
    const overlap = nativePlan(store, tools, 'least_stock', [protectedId]);
    const restricted = nativePlan(store, tools, 'least_stock', [workspace.stock[0]!.id]);
    // Equal effective constraints do not erase different declared reuse keys.
    expect(overlap.reusedFromPlanId).toBeNull();
    const comparison = invoke(tools, 'compare_plans', {
      planIds: [first.id, overlap.id, restricted.id],
    });
    expect(comparison).toMatchObject({
      ok: true,
      revision: workspace.revision,
      baselinePlanId: first.id,
      protectedStockIds: [protectedId],
      sameConstraints: false,
      plans: [
        { id: first.id, excludedStockIds: [], sameConstraintsAsFirst: true },
        {
          id: overlap.id,
          excludedStockIds: [protectedId],
          sameConstraintsAsFirst: true,
          deltaFromFirst: { stockUsedMm: 0, boardCount: 0, wasteMm: 0, reusableMm: 0 },
        },
        {
          id: restricted.id,
          excludedStockIds: [workspace.stock[0]!.id],
          sameConstraintsAsFirst: false,
          deltaFromFirst: { stockUsedMm: 100, boardCount: -1, wasteMm: -194, reusableMm: 294 },
        },
      ],
    });
    for (const planIds of [
      [first.id, overlap.id],
      [overlap.id, first.id],
    ]) {
      expect(invoke(tools, 'compare_plans', { planIds })).toMatchObject({
        ok: true,
        baselinePlanId: planIds[0],
        protectedStockIds: [protectedId],
        sameConstraints: true,
        plans: [{ sameConstraintsAsFirst: true }, { sameConstraintsAsFirst: true }],
      });
    }
    expect(store.getSnapshot().workspace).toBe(workspace);
    expect(store.getSnapshot().approvedPlanId).toBeNull();
  });

  test('equal-sized different exclusion sets remain different even when their material balances match', () => {
    const store = createJob();
    const tools = createToolDefinitions(store);
    const workspace = store.getSnapshot().workspace;
    const firstId = workspace.stock[0]!.id;
    const secondId = workspace.stock[1]!.id;
    const protectedId = workspace.stock[3]!.id;
    const first = nativePlan(store, tools, 'least_stock', [firstId]);
    const different = nativePlan(store, tools, 'least_stock', [secondId]);
    const overlap = nativePlan(store, tools, 'least_stock', [protectedId, firstId]);
    expect(different.solution.metrics).toEqual(first.solution.metrics);
    expect(overlap.solution.excludedStockIds).toEqual([firstId, protectedId]);
    expect(overlap.reusedFromPlanId).toBeNull();
    expect(
      invoke(tools, 'compare_plans', {
        planIds: [first.id, different.id, overlap.id],
      }),
    ).toMatchObject({
      ok: true,
      protectedStockIds: [protectedId],
      sameConstraints: false,
      plans: [
        { id: first.id, excludedStockIds: [firstId], sameConstraintsAsFirst: true },
        {
          id: different.id,
          excludedStockIds: [secondId],
          sameConstraintsAsFirst: false,
          deltaFromFirst: {
            stockUsedMm: 0,
            boardCount: 0,
            wasteMm: 0,
            reusableMm: 0,
            utilizationPercentagePoints: 0,
          },
        },
        {
          id: overlap.id,
          excludedStockIds: [firstId, protectedId],
          sameConstraintsAsFirst: true,
        },
      ],
    });
  });

  test('reused checked search results have new unapproved IDs and visible provenance, never inherited approval', () => {
    const store = createJob();
    const tools = createToolDefinitions(store);
    const workspace = store.getSnapshot().workspace;
    const exclusions = [workspace.stock[0]!.id, workspace.stock[3]!.id];
    const first = nativePlan(store, tools, 'least_stock', exclusions);
    expect(first.reusedFromPlanId).toBeNull();
    expect(
      invoke(tools, 'stage_plan_for_review', {
        planId: first.id,
        expectedRevision: workspace.revision,
      }),
    ).toMatchObject({ ok: true, status: 'awaiting_human_approval' });
    store.approvePlan(first.id);
    const reused = nativePlan(store, tools, 'least_stock', [...exclusions].reverse());
    expect(reused.id).not.toBe(first.id);
    expect(reused.reusedFromPlanId).toBe(first.id);
    expect(reused.solution).toBe(first.solution);
    expect(reused.solution.search).toEqual(first.solution.search);
    expect(store.getSnapshot()).toMatchObject({
      selectedPlanId: reused.id,
      approvedPlanId: first.id,
      reviewPlanId: null,
    });
    expect(invoke(tools, 'inspect_plan', { planId: reused.id })).toMatchObject({
      ok: true,
      plan: {
        id: reused.id,
        reusedFromPlanId: first.id,
        basedOnRevision: workspace.revision,
        pendingMeasurements: false,
        fresh: true,
        approved: false,
        awaitingHumanApproval: false,
        canRequestReview: true,
        solution: { excludedStockIds: exclusions, search: first.solution.search },
      },
    });
    expect(invoke(tools, 'get_workshop', {})).toMatchObject({
      ok: true,
      pendingMeasurements: false,
      plans: [
        { id: first.id, reusedFromPlanId: null, approved: true },
        {
          id: reused.id,
          reusedFromPlanId: first.id,
          approved: false,
          search: first.solution.search,
        },
      ],
    });
    expect(invoke(tools, 'compare_plans', { planIds: [first.id, reused.id] })).toMatchObject({
      ok: true,
      sameConstraints: true,
      plans: [
        { id: first.id, reusedFromPlanId: null },
        {
          id: reused.id,
          reusedFromPlanId: first.id,
          provenOptimal: first.solution.search.provenOptimal,
        },
      ],
    });
    expectRejected(store, tools, 'export_cut_list', { planId: reused.id }, 'APPROVAL_REQUIRED');
    expect(invoke(tools, 'export_cut_list', { planId: first.id })).toMatchObject({
      ok: true,
      planId: first.id,
      filename: `offcut-my-next-project-r${workspace.revision}-${first.id}.csv`,
    });
    store.setSettings({ kerfMm: 4 });
    const fresh = nativePlan(store, tools, 'least_stock', exclusions);
    expect(fresh.reusedFromPlanId).toBeNull();
    expect(fresh.solution).not.toBe(first.solution);
    expect(fresh.solution.metrics.kerfMm).toBe(8);
    expect(invoke(tools, 'inspect_plan', { planId: reused.id })).toMatchObject({
      ok: true,
      plan: {
        id: reused.id,
        reusedFromPlanId: first.id,
        fresh: false,
        approved: false,
        canRequestReview: false,
      },
    });
  });

  test('pending measurements block staging while native inspection and planning use committed values, then recover', () => {
    const { store, tools, first, second } = createSession();
    const workspace = store.getSnapshot().workspace;
    store.setPendingMeasurements(true);
    expect(invoke(tools, 'get_workshop', {})).toMatchObject({
      ok: true,
      workspace,
      pendingMeasurements: true,
    });
    expect(invoke(tools, 'inspect_plan', { planId: first.id })).toMatchObject({
      ok: true,
      plan: {
        id: first.id,
        pendingMeasurements: true,
        fresh: true,
        approved: false,
        awaitingHumanApproval: false,
        canRequestReview: false,
        solution: first.solution,
      },
    });
    const draft = nativePlan(store, tools, 'least_waste');
    expect(draft.basedOnRevision).toBe(workspace.revision);
    expect(draft.solution.complete).toBe(true);
    expect(draft.solution.metrics.kerfMm).toBe(6);
    expect(invoke(tools, 'compare_plans', { planIds: [first.id, second.id] })).toMatchObject({
      ok: true,
      revision: workspace.revision,
      sameConstraints: true,
    });
    expectRejected(
      store,
      tools,
      'stage_plan_for_review',
      {
        planId: first.id,
        expectedRevision: workspace.revision,
      },
      'PENDING_MEASUREMENTS',
    );
    expect(store.getSnapshot()).toMatchObject({
      pendingMeasurements: true,
      selectedPlanId: draft.id,
      reviewPlanId: null,
      approvedPlanId: null,
    });
    expect(store.getSnapshot().workspace).toBe(workspace);
    store.setPendingMeasurements(false);
    expect(
      invoke(tools, 'stage_plan_for_review', {
        planId: first.id,
        expectedRevision: workspace.revision,
      }),
    ).toMatchObject({
      ok: true,
      status: 'awaiting_human_approval',
      plan: {
        id: first.id,
        pendingMeasurements: false,
        canRequestReview: true,
        awaitingHumanApproval: true,
        approved: false,
      },
    });
    expect(store.getSnapshot().workspace).toBe(workspace);
  });

  test('pending drafts preserve existing review and approval and still allow the exact approved committed native export', () => {
    const { store, tools, first, second } = createSession();
    const workspace = store.getSnapshot().workspace;
    invoke(tools, 'stage_plan_for_review', {
      planId: first.id,
      expectedRevision: workspace.revision,
    });
    store.approvePlan(first.id);
    invoke(tools, 'stage_plan_for_review', {
      planId: second.id,
      expectedRevision: workspace.revision,
    });
    store.setPendingMeasurements(true);
    expect(invoke(tools, 'inspect_plan', { planId: first.id })).toMatchObject({
      ok: true,
      plan: {
        id: first.id,
        pendingMeasurements: true,
        approved: true,
        awaitingHumanApproval: false,
        canRequestReview: false,
      },
    });
    expect(invoke(tools, 'inspect_plan', { planId: second.id })).toMatchObject({
      ok: true,
      plan: {
        id: second.id,
        pendingMeasurements: true,
        approved: false,
        awaitingHumanApproval: true,
        canRequestReview: false,
      },
    });
    for (const planId of [second.id, first.id]) {
      expectRejected(
        store,
        tools,
        'stage_plan_for_review',
        {
          planId,
          expectedRevision: workspace.revision,
        },
        'PENDING_MEASUREMENTS',
      );
    }
    const exported = invoke(tools, 'export_cut_list', { planId: first.id });
    expect(exported).toMatchObject({
      ok: true,
      planId: first.id,
      revision: workspace.revision,
      filename: `offcut-my-next-project-r${workspace.revision}-${first.id}.csv`,
    });
    const [, ...rows] = csvRows(exported.csv as string);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.length === 17 && row[2] === first.id)).toBe(true);
    expectRejected(store, tools, 'export_cut_list', { planId: second.id }, 'APPROVAL_REQUIRED');
    expect(store.getSnapshot()).toMatchObject({
      pendingMeasurements: true,
      selectedPlanId: second.id,
      reviewPlanId: second.id,
      approvedPlanId: first.id,
    });
    expect(store.getSnapshot().workspace).toBe(workspace);
    store.setPendingMeasurements(false);
    expect(
      invoke(tools, 'stage_plan_for_review', {
        planId: second.id,
        expectedRevision: workspace.revision,
      }),
    ).toMatchObject({ ok: true, status: 'awaiting_human_approval' });
    store.approvePlan(second.id);
    expect(invoke(tools, 'inspect_plan', { planId: second.id })).toMatchObject({
      ok: true,
      plan: {
        id: second.id,
        pendingMeasurements: false,
        approved: true,
        awaitingHumanApproval: false,
      },
    });
  });

  test('full 40-part native layouts and 17-column CSV retain distinct requirement IDs despite identical human labels', () => {
    const store = createWorkshopStore(null);
    store.clearWorkspace();
    store.setSettings({ kerfMm: 20, minReusableMm: 100 });
    store.addStock({
      label: 'Maximum usable length',
      lengthMm: 100_000,
      kind: 'board',
      locked: false,
    });
    const label = 'Panel, "same label"';
    store.addRequirement({ label, lengthMm: 1000, quantity: 20 });
    store.addRequirement({ label, lengthMm: 1000, quantity: 20 });
    const workspace = store.getSnapshot().workspace;
    const tools = createToolDefinitions(store);
    expect(invoke(tools, 'get_workshop', {})).toMatchObject({
      ok: true,
      workspace: { requirements: workspace.requirements },
      totalRequiredParts: 40,
      requiredPartsMm: 40_000,
    });
    const plan = nativePlan(store, tools, 'least_stock');
    expect(plan.solution.complete).toBe(true);
    expect(plan.solution.layouts).toHaveLength(1);
    expect(plan.solution.layouts[0]!.cuts).toHaveLength(40);
    expect(plan.solution.metrics).toMatchObject({
      partsMm: 40_000,
      kerfMm: 800,
      reusableMm: 59_200,
    });
    expect(invoke(tools, 'inspect_plan', { planId: plan.id })).toMatchObject({
      ok: true,
      plan: { id: plan.id, solution: plan.solution },
    });
    expect(
      invoke(tools, 'stage_plan_for_review', {
        planId: plan.id,
        expectedRevision: workspace.revision,
      }),
    ).toMatchObject({
      ok: true,
      status: 'awaiting_human_approval',
      plan: { id: plan.id, solution: plan.solution, approved: false },
    });
    store.approvePlan(plan.id);
    const exported = invoke(tools, 'export_cut_list', { planId: plan.id });
    expect(exported).toMatchObject({
      ok: true,
      planId: plan.id,
      filename: `offcut-my-next-project-r${workspace.revision}-${plan.id}.csv`,
    });
    const [header, ...rows] = csvRows(exported.csv as string);
    expect(header).toEqual([
      'Project',
      'Material (same cross-section)',
      'Plan ID',
      'Workspace revision',
      'Board ID',
      'Board label',
      'Usable stock length (mm)',
      'Cut order',
      'Part ID',
      'Part',
      'Part instance',
      'Part length (mm)',
      'Start from usable edge (mm)',
      'End before kerf (mm)',
      'Kerf after this part (mm)',
      'Final remnant (mm)',
      'Remnant class',
    ]);
    expect(rows).toHaveLength(40);
    const layout = plan.solution.layouts[0]!;
    for (let index = 0; index < rows.length; index++) {
      const cut = layout.cuts[index]!;
      expect(rows[index]).toEqual([
        workspace.title,
        workspace.material,
        plan.id,
        String(workspace.revision),
        layout.stockId,
        layout.stockLabel,
        '100000',
        String(index + 1),
        cut.requirementId,
        label,
        String(cut.instance),
        '1000',
        String(cut.offsetMm),
        String(cut.offsetMm + cut.lengthMm),
        '20',
        index === rows.length - 1 ? '59200' : '',
        index === rows.length - 1 ? 'reusable' : '',
      ]);
    }
    expect(new Set(rows.map((row) => row[8])).size).toBe(2);
    for (const requirement of workspace.requirements) {
      const matching = rows.filter((row) => row[8] === requirement.id);
      expect(matching).toHaveLength(20);
      expect(matching.map((row) => Number(row[10])).sort((left, right) => left - right)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
    }
    expect(store.getSnapshot().workspace).toBe(workspace);
  });
});

describe('handler validation independent of native input schemas', () => {
  test.each([...TOOL_NAMES])('%s rejects JSON values that are not input objects', (name) => {
    const { store, tools } = createSession();
    for (const input of [null, [], [{}], true, 7, '{}'])
      expectRejected(store, tools, name, input, 'INVALID_INPUT');
  });

  test.each([...TOOL_NAMES])(
    '%s rejects unknown, forged authority, physical-edit and prototype-shaped JSON fields',
    (name) => {
      const { store, tools, first, second } = createSession();
      store.stagePlan(second.id, store.getSnapshot().workspace.revision);
      store.setPendingMeasurements(true);
      const input = validInput(name, store.getSnapshot(), first, second);
      const fields: [string, unknown][] = [
        ['unknown', true],
        ['approve', true],
        ['approved', true],
        ['approvedPlanId', first.id],
        ['reviewPlanId', first.id],
        ['pendingMeasurements', false],
        ['reusedFromPlanId', first.id],
        ['protectedStockIds', []],
        ['sameConstraints', true],
        ['sameConstraintsAsFirst', true],
        ['actor', 'human'],
        ['settings', { kerfMm: 0, minReusableMm: 0 }],
        ['kerfMm', 0],
        ['lengthMm', 100_000],
        ['stock', []],
        ['requirements', []],
        ['locked', false],
        ['unlockStockIds', [store.getSnapshot().workspace.stock[3]!.id]],
        ['__proto__', { approvedPlanId: first.id, actor: 'human', locked: false }],
        ['constructor', { prototype: { approvedPlanId: first.id, actor: 'human' } }],
        ['prototype', { approvedPlanId: first.id }],
      ];
      for (const [field, value] of fields)
        expectRejected(store, tools, name, { ...input, [field]: value }, 'INVALID_INPUT');
      expect(store.getSnapshot().approvedPlanId).toBeNull();
      expect(store.getSnapshot().workspace.stock[3]!.locked).toBe(true);
    },
  );

  test.each(['plan_cuts', 'stage_plan_for_review'] as const)(
    '%s rejects missing, nonnumeric, fractional and unsafe revisions',
    (name) => {
      const { store, tools, first, second } = createSession();
      const base = validInput(name, store.getSnapshot(), first, second);
      for (const expectedRevision of [
        undefined,
        null,
        '0',
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        true,
        {},
        [],
      ]) {
        expectRejected(store, tools, name, { ...base, expectedRevision }, 'INVALID_INPUT');
      }
    },
  );

  test('plan_cuts rejects unsupported objectives, including inherited-object property names', () => {
    const { store, tools } = createSession();
    const expectedRevision = store.getSnapshot().workspace.revision;
    for (const objective of [
      undefined,
      null,
      'leastStock',
      'LEAST_STOCK',
      '__proto__',
      'constructor',
      'toString',
      0,
      true,
      {},
      [],
    ]) {
      expectRejected(store, tools, 'plan_cuts', { expectedRevision, objective }, 'INVALID_INPUT');
    }
  });

  test.each(['inspect_plan', 'stage_plan_for_review', 'export_cut_list'] as const)(
    '%s validates IDs instead of coercing or selecting a fallback',
    (name) => {
      const { store, tools, first, second } = createSession();
      const base = validInput(name, store.getSnapshot(), first, second);
      store.setPendingMeasurements(true);
      for (const planId of [
        undefined,
        null,
        1,
        true,
        '',
        '   ',
        ` ${first.id}`,
        `${first.id} `,
        'p'.repeat(65),
        {},
        [],
      ]) {
        expectRejected(store, tools, name, { ...base, planId }, 'INVALID_INPUT');
      }
      for (const planId of ['not-in-this-session', '__proto__', 'constructor']) {
        expectRejected(store, tools, name, { ...base, planId }, 'PLAN_NOT_FOUND');
      }
    },
  );

  test('plan_cuts rejects malformed, duplicate, excessive and unknown exclusions', () => {
    const { store, tools } = createSession();
    const workspace = store.getSnapshot().workspace;
    const knownId = workspace.stock[0]!.id;
    const protectedId = workspace.stock[3]!.id;
    const malformed = [
      null,
      knownId,
      { stockId: knownId },
      [knownId, knownId],
      [protectedId, protectedId],
      [knownId, protectedId, protectedId],
      [''],
      ['   '],
      [` ${knownId}`],
      [`${knownId} `],
      [` ${protectedId}`],
      ['s'.repeat(65)],
      [1],
      [{ id: knownId, locked: false }],
      Array.from({ length: LIMITS.stockBoards + 1 }, (_, index) => `stock-${index}`),
    ];
    for (const excludedStockIds of malformed) {
      expectRejected(
        store,
        tools,
        'plan_cuts',
        { expectedRevision: workspace.revision, objective: 'least_stock', excludedStockIds },
        'INVALID_INPUT',
      );
    }
    const unknown = expectRejected(
      store,
      tools,
      'plan_cuts',
      {
        expectedRevision: workspace.revision,
        objective: 'least_stock',
        excludedStockIds: ['missing-stock'],
      },
      'UNKNOWN_STOCK',
    );
    expect(unknown.error!.details).toEqual({ stockId: 'missing-stock' });
    for (const excludedStockIds of [
      [protectedId, 'missing-stock'],
      ['missing-stock', protectedId],
    ]) {
      const rejected = expectRejected(
        store,
        tools,
        'plan_cuts',
        {
          expectedRevision: workspace.revision,
          objective: 'least_stock',
          excludedStockIds,
        },
        'UNKNOWN_STOCK',
      );
      expect(rejected.error!.details).toEqual({ stockId: 'missing-stock' });
    }
  });

  test('compare_plans requires two or three distinct existing IDs, not a partial or coerced list', () => {
    const { store, tools, first, second } = createSession();
    const malformed = [
      undefined,
      null,
      first.id,
      [],
      [first.id],
      [first.id, first.id],
      [first.id, second.id, second.id],
      [first.id, second.id, 'third', 'fourth'],
      [first.id, 1],
      [first.id, null],
      [first.id, ` ${second.id}`],
      [first.id, 'p'.repeat(65)],
    ];
    for (const planIds of malformed)
      expectRejected(store, tools, 'compare_plans', { planIds }, 'INVALID_INPUT');
    expectRejected(
      store,
      tools,
      'compare_plans',
      { planIds: [first.id, 'missing-plan'] },
      'PLAN_NOT_FOUND',
    );
  });
});

describe('revision freshness and native cancellation', () => {
  test('stale mutations, comparisons and exports fail while inspection truthfully reports the old basis', () => {
    const { store, tools, first, second } = createSession();
    const oldRevision = store.getSnapshot().workspace.revision;
    invoke(tools, 'stage_plan_for_review', { planId: first.id, expectedRevision: oldRevision });
    store.approvePlan(first.id);
    store.updateProject({ title: 'Human changed the job after approval' });
    store.setPendingMeasurements(true);
    const currentRevision = store.getSnapshot().workspace.revision;
    const conflict = expectRejected(
      store,
      tools,
      'plan_cuts',
      { expectedRevision: oldRevision, objective: 'least_stock' },
      'REVISION_CONFLICT',
    );
    expect(conflict.error!.details).toEqual({ expectedRevision: oldRevision, currentRevision });
    expectRejected(
      store,
      tools,
      'stage_plan_for_review',
      { planId: first.id, expectedRevision: oldRevision },
      'REVISION_CONFLICT',
    );
    expectRejected(
      store,
      tools,
      'stage_plan_for_review',
      { planId: first.id, expectedRevision: currentRevision },
      'STALE_PLAN',
    );
    expectRejected(
      store,
      tools,
      'plan_cuts',
      { expectedRevision: currentRevision + 1, objective: 'least_stock' },
      'REVISION_CONFLICT',
    );
    expectRejected(store, tools, 'compare_plans', { planIds: [first.id, second.id] }, 'STALE_PLAN');
    expectRejected(store, tools, 'export_cut_list', { planId: first.id }, 'STALE_PLAN');
    const inspection = invoke(tools, 'inspect_plan', { planId: first.id });
    expect(inspection).toMatchObject({
      ok: true,
      plan: {
        id: first.id,
        basedOnRevision: oldRevision,
        currentRevision,
        pendingMeasurements: true,
        fresh: false,
        approved: false,
        awaitingHumanApproval: false,
        canRequestReview: false,
      },
    });
    const workshop = invoke(tools, 'get_workshop', {});
    expect(workshop).toMatchObject({
      ok: true,
      pendingMeasurements: true,
      workspace: { revision: currentRevision },
    });
    expect(workshop.plans).toMatchObject([
      { id: first.id, fresh: false, approved: false },
      { id: second.id, fresh: false, approved: false },
    ]);
    expect(store.getSnapshot().plans).toHaveLength(2);
    expect(store.getSnapshot().approvedPlanId).toBeNull();
    expect(store.getSnapshot().reviewPlanId).toBeNull();
  });

  test.each(['execution', 'registration'] as const)(
    'an already-aborted %s signal cancels every tool before its operation runs',
    (scope) => {
      const { store, tools: originalTools, first, second } = createSession();
      store.stagePlan(first.id, store.getSnapshot().workspace.revision);
      store.approvePlan(first.id);
      store.stagePlan(second.id, store.getSnapshot().workspace.revision);
      store.setPendingMeasurements(true);
      const controller = new AbortController();
      const tools =
        scope === 'registration' ? createToolDefinitions(store, controller.signal) : originalTools;
      controller.abort();
      for (const name of TOOL_NAMES) {
        const input = validInput(name, store.getSnapshot(), first, second);
        expectRejected(
          store,
          tools,
          name,
          input,
          'ABORTED',
          scope === 'execution' ? controller.signal : undefined,
        );
      }
      expect(store.getSnapshot()).toMatchObject({
        approvedPlanId: first.id,
        pendingMeasurements: true,
        reviewPlanId: second.id,
        selectedPlanId: second.id,
      });
    },
  );
});
