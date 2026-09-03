import { describe, expect, test } from 'bun:test';
import { WorkshopError } from './errors';
import { exportApprovedPlan } from './export';
import type { Objective, PlanRecord, WorkshopStore } from './types';
import { createWorkshopStore } from './workshop-store';

function createTextJob(): WorkshopStore {
  const store = createWorkshopStore(null);
  store.clearWorkspace();
  store.updateProject({ title: 'Bench, "East"', material: 'Pine, 18 × 140 mm' });
  store.setSettings({ kerfMm: 3, minReusableMm: 100 });
  store.addStock({ label: 'Usable "A", board', lengthMm: 1000, kind: 'board', locked: false });
  store.addStock({ label: 'Do not cut, "reserve"', lengthMm: 1500, kind: 'board', locked: true });
  store.addRequirement({ label: 'Shelf, "wide"', lengthMm: 300, quantity: 2 });
  store.addRequirement({ label: 'Brace, "small"', lengthMm: 100, quantity: 1 });
  return store;
}

function propose(store: WorkshopStore, objective: Objective = 'least_stock'): PlanRecord {
  return store.proposePlan({ expectedRevision: store.getSnapshot().workspace.revision, objective });
}

function reviewedAndApproved(store: WorkshopStore): PlanRecord {
  const plan = propose(store);
  store.stagePlan(plan.id, store.getSnapshot().workspace.revision);
  return store.approvePlan(plan.id);
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkshopError);
    expect((error as WorkshopError).code).toBe(code);
    return;
  }
  throw new Error(`Expected WorkshopError ${code}`);
}

// Read every quoted CSV cell, including escaped quotes and embedded commas; reject skipped or unterminated bytes.
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

describe('content from real reviewed and approved plans', () => {
  test('CSV quotes human commas and quotes and releases every exact approved part instance and offset', () => {
    const store = createTextJob();
    const approved = reviewedAndApproved(store);
    const snapshot = store.getSnapshot();
    const board = snapshot.workspace.stock[0]!;
    const shelf = snapshot.workspace.requirements[0]!;
    const brace = snapshot.workspace.requirements[1]!;
    const exported = exportApprovedPlan(snapshot, approved.id);
    const [header, ...rows] = csvRows(exported.csv);
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
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.slice(8, 12))).toEqual(
      expect.arrayContaining([
        [shelf.id, shelf.label, '1', '300'],
        [shelf.id, shelf.label, '2', '300'],
        [brace.id, brace.label, '1', '100'],
      ]),
    );
    expect(approved.solution.layouts).toHaveLength(1);
    let offset = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const cut = approved.solution.layouts[0]!.cuts[index]!;
      expect(row).toHaveLength(17);
      expect(row.slice(0, 8)).toEqual([
        'Bench, "East"',
        'Pine, 18 × 140 mm',
        approved.id,
        String(snapshot.workspace.revision),
        board.id,
        'Usable "A", board',
        '1000',
        String(index + 1),
      ]);
      expect(row.slice(8, 15)).toEqual([
        cut.requirementId,
        cut.label,
        String(cut.instance),
        String(cut.lengthMm),
        String(offset),
        String(offset + cut.lengthMm),
        '3',
      ]);
      expect(row.slice(15)).toEqual(index === rows.length - 1 ? ['291', 'reusable'] : ['', '']);
      offset += cut.lengthMm + 3;
    }
    expect(offset).toBe(709);
    expect(exported.csv).toContain('"Bench, ""East"""');
    expect(exported.csv).toContain('"Usable ""A"", board"');
    expect(exported.csv).toContain('"Shelf, ""wide"""');
    expect(exported.csv).not.toContain(snapshot.workspace.stock[1]!.id);
    expect(exported.filename).toBe(
      `offcut-bench-east-r${snapshot.workspace.revision}-${approved.id}.csv`,
    );
    expect(store.getSnapshot()).toBe(snapshot);
  });

  test.each(['=SUM(1,2)', '+SUM(1,2)', '-1+2', '@SUM(1,2)', '   =SUM(1,2)', '\u00a0@SUM(1,2)'])(
    'permitted formula-prefix text %s is neutralized in every human text column',
    (formula) => {
      const store = createTextJob();
      const workspace = store.getSnapshot().workspace;
      const title = `${formula}, "Project"`;
      const material = `${formula}, "Pine"`;
      const stockLabel = `${formula}, "Board"`;
      store.updateProject({ title, material });
      store.updateStock(workspace.stock[0]!.id, { label: stockLabel });
      store.updateRequirement(workspace.requirements[0]!.id, { label: `${formula}, "Shelf"` });
      store.updateRequirement(workspace.requirements[1]!.id, { label: `${formula}, "Brace"` });
      const physical = store.getSnapshot().workspace;
      const approved = reviewedAndApproved(store);
      const snapshot = store.getSnapshot();
      const exported = exportApprovedPlan(snapshot, approved.id);
      const [, ...rows] = csvRows(exported.csv);
      expect(rows).toHaveLength(3);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const cut = approved.solution.layouts[0]!.cuts[index]!;
        expect(row).toHaveLength(17);
        expect(row[0]).toBe(`'${title}`);
        expect(row[1]).toBe(`'${material}`);
        expect(row[2]).toBe(approved.id);
        expect(row[4]).toBe(workspace.stock[0]!.id);
        expect(row[5]).toBe(`'${stockLabel}`);
        expect(row[8]).toBe(cut.requirementId);
        expect(row[9]).toBe(`'${cut.label}`);
        expect(row[6]).toBe('1000');
        expect(row[11]).toBe(String(cut.lengthMm));
        expect(row[14]).toBe('3');
      }
      expect(exported.csv).toContain(`"'${formula}, ""Project"""`);
      expect(snapshot.workspace).toBe(physical);
      expect(snapshot.workspace.title).toBe(title);
      expect(snapshot.workspace.stock[0]!.label).toBe(stockLabel);
      expect(store.getSnapshot()).toBe(snapshot);
    },
  );

  test('non-prefix operators, leading spaces and already-safe apostrophes remain literal human text', () => {
    const store = createTextJob();
    const workspace = store.getSnapshot().workspace;
    const title = 'Bench =SUM(1,2), "East"';
    const material = 'Pine + Oak, "stock"';
    const boardLabel = '  Usable, "board"';
    const shelfLabel = '\'Already text, "wide"';
    store.updateProject({ title, material });
    store.updateStock(workspace.stock[0]!.id, { label: boardLabel });
    store.updateRequirement(workspace.requirements[0]!.id, { label: shelfLabel });
    const approved = reviewedAndApproved(store);
    const [, ...rows] = csvRows(exportApprovedPlan(store.getSnapshot(), approved.id).csv);
    for (const row of rows) {
      expect(row[0]).toBe(title);
      expect(row[1]).toBe(material);
      expect(row[5]).toBe(boardLabel);
    }
    expect(rows.filter((row) => row[9] === shelfLabel)).toHaveLength(2);
  });

  test('duplicate formula-prefixed part labels retain distinct requirement IDs and instances', () => {
    const store = createTextJob();
    const initial = store.getSnapshot().workspace;
    const label = '=SUM(1,2), "Repeated part"';
    for (const requirement of initial.requirements) {
      store.updateRequirement(requirement.id, { label, lengthMm: 300 });
    }
    const approved = reviewedAndApproved(store);
    const snapshot = store.getSnapshot();
    const exported = exportApprovedPlan(snapshot, approved.id);
    const [header, ...rows] = csvRows(exported.csv);
    expect(header).toHaveLength(17);
    expect(header!.slice(8, 12)).toEqual(['Part ID', 'Part', 'Part instance', 'Part length (mm)']);
    expect(rows).toHaveLength(3);
    expect([...new Set(rows.map((row) => row[8]))].sort()).toEqual(
      snapshot.workspace.requirements.map((requirement) => requirement.id).sort(),
    );
    for (const requirement of snapshot.workspace.requirements) {
      const partRows = rows.filter((row) => row[8] === requirement.id);
      expect(partRows).toHaveLength(requirement.quantity);
      expect(partRows.map((row) => row[10]).sort()).toEqual(
        Array.from({ length: requirement.quantity }, (_, index) => String(index + 1)),
      );
      for (const row of partRows) {
        expect(row).toHaveLength(17);
        expect(row[9]).toBe(`'${label}`);
        expect(row[11]).toBe('300');
      }
      expect(requirement.label).toBe(label);
    }
    expect(exported.csv).toContain(`"'=SUM(1,2), ""Repeated part"""`);
    expect(store.getSnapshot()).toBe(snapshot);
  });

  test('a selected draft with a different physical layout cannot replace the approved cut sheet', () => {
    const store = createTextJob();
    const initial = store.getSnapshot().workspace;
    store.updateStock(initial.stock[0]!.id, { lengthMm: 700 });
    store.addStock({ label: 'Second short board', lengthMm: 700, kind: 'offcut', locked: false });
    store.addStock({
      label: 'Unapproved long layout',
      lengthMm: 1500,
      kind: 'board',
      locked: false,
    });
    store.updateRequirement(initial.requirements[0]!.id, { lengthMm: 600 });
    store.removeRequirement(initial.requirements[1]!.id);
    const approved = reviewedAndApproved(store);
    const draft = propose(store, 'fewest_boards');
    const snapshot = store.getSnapshot();
    expect(approved.solution.layouts).toHaveLength(2);
    expect(draft.solution.layouts).toHaveLength(1);
    expect(snapshot.selectedPlanId).toBe(draft.id);
    expect(snapshot.approvedPlanId).toBe(approved.id);
    const [, ...rows] = csvRows(exportApprovedPlan(snapshot, approved.id).csv);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row[2])).toEqual([approved.id, approved.id]);
    expect(rows.map((row) => row[4]).sort()).toEqual(
      [initial.stock[0]!.id, snapshot.workspace.stock[2]!.id].sort(),
    );
    expect(rows.map((row) => row[10]).sort()).toEqual(['1', '2']);
    for (const row of rows) {
      expect(row[6]).toBe('700');
      expect(row[8]).toBe(initial.requirements[0]!.id);
      expect(row[9]).toBe(initial.requirements[0]!.label);
      expect(row[11]).toBe('600');
      expect(row[4]).not.toBe(draft.solution.layouts[0]!.stockId);
    }
    expectCode(() => exportApprovedPlan(snapshot, draft.id), 'APPROVAL_REQUIRED');
    expect(store.getSnapshot()).toBe(snapshot);
  });

  test('approved three- and six-board plans at one revision export distinct full-ID filenames and exact layouts', () => {
    const store = createWorkshopStore(null);
    store.updateStock('A-01', { locked: true });
    const workspace = store.getSnapshot().workspace;
    const leastStock = reviewedAndApproved(store);
    expect(leastStock.solution.layouts).toHaveLength(3);
    const threeBoardExport = exportApprovedPlan(store.getSnapshot(), leastStock.id);

    const leastWaste = propose(store, 'least_waste');
    expect(leastWaste.solution.layouts).toHaveLength(6);
    expect(leastWaste.id).not.toBe(leastStock.id);
    expect(leastWaste.basedOnRevision).toBe(leastStock.basedOnRevision);
    const selected = store.getSnapshot();
    expect(selected.workspace).toBe(workspace);
    expect(selected.selectedPlanId).toBe(leastWaste.id);
    expect(selected.approvedPlanId).toBe(leastStock.id);
    expectCode(() => exportApprovedPlan(selected, leastWaste.id), 'APPROVAL_REQUIRED');
    expect(exportApprovedPlan(selected, leastStock.id)).toEqual(threeBoardExport);

    store.stagePlan(leastWaste.id, workspace.revision);
    const reviewing = store.getSnapshot();
    expectCode(() => exportApprovedPlan(reviewing, leastWaste.id), 'APPROVAL_REQUIRED');
    expect(exportApprovedPlan(reviewing, leastStock.id)).toEqual(threeBoardExport);
    store.approvePlan(leastWaste.id);
    const approved = store.getSnapshot();
    expect(approved.workspace).toBe(workspace);
    expect(approved.approvedPlanId).toBe(leastWaste.id);
    const sixBoardExport = exportApprovedPlan(approved, leastWaste.id);
    expectCode(() => exportApprovedPlan(approved, leastStock.id), 'APPROVAL_REQUIRED');
    expect(threeBoardExport.filename).not.toBe(sixBoardExport.filename);

    for (const [plan, exported] of [
      [leastStock, threeBoardExport],
      [leastWaste, sixBoardExport],
    ] as const) {
      expect(exported.filename).toBe(
        `offcut-the-little-library-r${workspace.revision}-${plan.id}.csv`,
      );
      const [header, ...rows] = csvRows(exported.csv);
      expect(header).toHaveLength(17);
      expect(rows).toHaveLength(14);
      expect(new Set(rows.map((row) => row[4])).size).toBe(plan.solution.layouts.length);
      let rowIndex = 0;
      for (const layout of plan.solution.layouts) {
        for (let index = 0; index < layout.cuts.length; index++) {
          const cut = layout.cuts[index]!;
          const lastCut = index === layout.cuts.length - 1;
          expect(rows[rowIndex]).toEqual([
            workspace.title,
            workspace.material,
            plan.id,
            String(workspace.revision),
            layout.stockId,
            layout.stockLabel,
            String(layout.stockLengthMm),
            String(index + 1),
            cut.requirementId,
            cut.label,
            String(cut.instance),
            String(cut.lengthMm),
            String(cut.offsetMm),
            String(cut.offsetMm + cut.lengthMm),
            String(workspace.settings.kerfMm),
            lastCut ? String(layout.remnantMm) : '',
            lastCut ? layout.remnantKind : '',
          ]);
          rowIndex++;
        }
      }
      for (const requirement of workspace.requirements) {
        expect(
          rows
            .filter((row) => row[8] === requirement.id)
            .map((row) => row[10])
            .sort(),
        ).toEqual(Array.from({ length: requirement.quantity }, (_, index) => String(index + 1)));
      }
    }
    expect(store.getSnapshot()).toBe(approved);
  });
});

describe('approved export gates', () => {
  test('a fresh complete proposal and a staged review are both unreleased until human approval', () => {
    const store = createTextJob();
    const plan = propose(store);
    const draft = store.getSnapshot();
    expect(plan.solution.complete).toBe(true);
    expectCode(() => exportApprovedPlan(draft, plan.id), 'APPROVAL_REQUIRED');
    expect(store.getSnapshot()).toBe(draft);
    store.stagePlan(plan.id, draft.workspace.revision);
    const reviewing = store.getSnapshot();
    expectCode(() => exportApprovedPlan(reviewing, plan.id), 'APPROVAL_REQUIRED');
    expect(store.getSnapshot()).toBe(reviewing);
    store.approvePlan(plan.id);
    expect(csvRows(exportApprovedPlan(store.getSnapshot(), plan.id).csv)).toHaveLength(4);
  });

  test('a selected reused solution does not inherit the exact plan approval', () => {
    const store = createTextJob();
    const approved = reviewedAndApproved(store);
    const released = exportApprovedPlan(store.getSnapshot(), approved.id);
    const reused = propose(store);
    const snapshot = store.getSnapshot();
    expect(reused.id).not.toBe(approved.id);
    expect(reused.reusedFromPlanId).toBe(approved.id);
    expect(snapshot.selectedPlanId).toBe(reused.id);
    expect(snapshot.approvedPlanId).toBe(approved.id);
    expectCode(() => exportApprovedPlan(snapshot, reused.id), 'APPROVAL_REQUIRED');
    expect(exportApprovedPlan(snapshot, approved.id)).toEqual(released);
    expect(store.getSnapshot()).toBe(snapshot);
  });

  test('pending human drafts do not revoke export of the exact approved committed plan', () => {
    const store = createTextJob();
    const approved = reviewedAndApproved(store);
    const committed = store.getSnapshot();
    const released = exportApprovedPlan(committed, approved.id);
    store.setPendingMeasurements(true);
    const pending = store.getSnapshot();
    expect(pending.workspace).toBe(committed.workspace);
    expect(pending.approvedPlanId).toBe(approved.id);
    expect(exportApprovedPlan(pending, approved.id)).toEqual(released);
    expect(store.getSnapshot()).toBe(pending);
  });

  test('an actual incomplete plan is not a releasable cut sheet', () => {
    const store = createTextJob();
    store.updateStock(store.getSnapshot().workspace.stock[0]!.id, { lengthMm: 1 });
    const plan = propose(store);
    const snapshot = store.getSnapshot();
    expect(plan.solution.complete).toBe(false);
    expect(plan.solution.unfulfilled.length).toBeGreaterThan(0);
    expectCode(() => exportApprovedPlan(snapshot, plan.id), 'INCOMPLETE_PLAN');
    expect(store.getSnapshot()).toBe(snapshot);
  });

  test('a missing ID cannot fall back to the selected or approved plan', () => {
    const store = createTextJob();
    reviewedAndApproved(store);
    const snapshot = store.getSnapshot();
    expectCode(() => exportApprovedPlan(snapshot, 'missing-plan'), 'PLAN_NOT_FOUND');
    expect(store.getSnapshot()).toBe(snapshot);
  });

  test('an old approved basis remains stale even after the human restores identical kerf measurements', () => {
    const store = createTextJob();
    const approved = reviewedAndApproved(store);
    const before = store.getSnapshot();
    store.setSettings({ kerfMm: 4 });
    expectCode(() => exportApprovedPlan(store.getSnapshot(), approved.id), 'STALE_PLAN');
    store.setSettings({ kerfMm: 3 });
    const restoredMeasurements = store.getSnapshot();
    expect(restoredMeasurements.workspace.settings).toEqual(before.workspace.settings);
    expect(restoredMeasurements.workspace.revision).toBe(before.workspace.revision + 2);
    expect(restoredMeasurements.approvedPlanId).toBeNull();
    expect(restoredMeasurements.plans.find((plan) => plan.id === approved.id)).toBe(approved);
    expectCode(() => exportApprovedPlan(restoredMeasurements, approved.id), 'STALE_PLAN');
    const fresh = reviewedAndApproved(store);
    const [, ...rows] = csvRows(exportApprovedPlan(store.getSnapshot(), fresh.id).csv);
    expect(rows.every((row) => row[2] === fresh.id)).toBe(true);
    expect(rows.every((row) => row[3] === String(restoredMeasurements.workspace.revision))).toBe(
      true,
    );
  });

  test.each(['revokeApproval', 'rejectReview'] as const)(
    '%s withdraws a fresh plan from export until a new human review and approval',
    (operation) => {
      const store = createTextJob();
      const approved = reviewedAndApproved(store);
      const workspace = store.getSnapshot().workspace;
      if (operation === 'rejectReview') store.stagePlan(approved.id, workspace.revision);
      store[operation]();
      const withdrawn = store.getSnapshot();
      expect(withdrawn.approvedPlanId).toBeNull();
      expect(withdrawn.workspace).toBe(workspace);
      expectCode(() => exportApprovedPlan(withdrawn, approved.id), 'APPROVAL_REQUIRED');
      store.stagePlan(approved.id, workspace.revision);
      store.approvePlan(approved.id);
      const [, ...rows] = csvRows(exportApprovedPlan(store.getSnapshot(), approved.id).csv);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row[2] === approved.id)).toBe(true);
    },
  );
});
