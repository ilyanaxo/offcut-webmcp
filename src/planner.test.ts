import { describe, expect, test } from 'bun:test';
import { WorkshopError } from './errors';
import { solveCutPlan, validateWorkspace } from './planner';
import { LIMITS, type Objective, type PlanSolution, type Workspace } from './types';

const OBJECTIVES: readonly Objective[] = ['least_stock', 'fewest_boards', 'least_waste'];
type Score = [number, number, number];
type OracleScores = Record<Objective, Score | null>;
type RequirementInput = readonly [lengthMm: number, quantity: number];

function makeWorkspace(
  stockLengths: readonly number[],
  requirements: readonly RequirementInput[],
  settings: Workspace['settings'],
): Workspace {
  return {
    revision: 0,
    title: 'Planner contract fixture',
    material: 'Identical material and cross-section',
    stock: stockLengths.map((lengthMm, index) => ({
      id: `stock-${index + 1}`,
      label: `Board ${index + 1}`,
      lengthMm,
      kind: 'board',
      locked: false,
    })),
    requirements: requirements.map(([lengthMm, quantity], index) => ({
      id: `requirement-${index + 1}`,
      label: `Part ${index + 1}`,
      lengthMm,
      quantity,
    })),
    settings: { ...settings },
  };
}

function comesBefore(candidate: Score, incumbent: Score): boolean {
  for (let index = 0; index < candidate.length; index++) {
    if (candidate[index] !== incumbent[index]) return candidate[index] < incumbent[index];
  }
  return false;
}

/**
 * Enumerate the entire Cartesian product of physical-board assignments, then
 * reject overfull boards at the leaf. No sorting, symmetry reduction, greedy
 * incumbent, or search/objective pruning is shared with the production solver.
 * Generated jobs have at most six parts and four boards, so this stays small.
 * Only complete assignments are ranked: a partial plan is not an optimum.
 */
function exhaustiveScores(workspace: Workspace, excludedStockIds: readonly string[]): OracleScores {
  const excluded = new Set(excludedStockIds);
  const boards = workspace.stock.filter((board) => !board.locked && !excluded.has(board.id));
  const pieces = workspace.requirements.flatMap((requirement) =>
    Array.from({ length: requirement.quantity }, () => requirement.lengthMm),
  );
  const assignment = new Array<number>(pieces.length);
  const best: OracleScores = { least_stock: null, fewest_boards: null, least_waste: null };

  function enumerate(part: number): void {
    if (part < pieces.length) {
      for (let board = 0; board < boards.length; board++) {
        assignment[part] = board;
        enumerate(part + 1);
      }
      return;
    }

    const consumed = new Array<number>(boards.length).fill(0);
    const counts = new Array<number>(boards.length).fill(0);
    for (let index = 0; index < pieces.length; index++) {
      consumed[assignment[index]] += pieces[index] + workspace.settings.kerfMm;
      counts[assignment[index]]++;
    }
    if (boards.some((board, index) => consumed[index] > board.lengthMm)) return;

    let stockMm = 0;
    let boardCount = 0;
    let scrapMm = 0;
    for (let index = 0; index < boards.length; index++) {
      if (counts[index] === 0) continue;
      boardCount++;
      stockMm += boards[index].lengthMm;
      const remnant = boards[index].lengthMm - consumed[index];
      if (remnant > 0 && remnant < workspace.settings.minReusableMm) scrapMm += remnant;
    }
    const wasteMm = scrapMm + pieces.length * workspace.settings.kerfMm;
    const scores: Record<Objective, Score> = {
      least_stock: [stockMm, wasteMm, boardCount],
      fewest_boards: [boardCount, stockMm, wasteMm],
      least_waste: [wasteMm, stockMm, boardCount],
    };
    for (const objective of OBJECTIVES) {
      const incumbent = best[objective];
      if (incumbent === null || comesBefore(scores[objective], incumbent))
        best[objective] = scores[objective];
    }
  }

  enumerate(0);
  return best;
}

function solutionScore(solution: PlanSolution): Score {
  const { stockUsedMm, kerfMm, scrapMm, boardCount } = solution.metrics;
  switch (solution.objective) {
    case 'least_stock':
      return [stockUsedMm, kerfMm + scrapMm, boardCount];
    case 'fewest_boards':
      return [boardCount, stockUsedMm, kerfMm + scrapMm];
    case 'least_waste':
      return [kerfMm + scrapMm, stockUsedMm, boardCount];
  }
}

function solveUnchanged(
  workspace: Workspace,
  objective: Objective,
  excludedStockIds: string[] = [],
): PlanSolution {
  const before = structuredClone({ workspace, excludedStockIds });
  const solution = solveCutPlan(workspace, objective, excludedStockIds);
  expect({ workspace, excludedStockIds }).toEqual(before);
  expect(solution.objective).toBe(objective);
  return solution;
}

/** Check the physical cut sheet, not just the solver's aggregate score. */
function expectAccounting(
  workspace: Workspace,
  solution: PlanSolution,
  excludedStockIds: readonly string[] = [],
): void {
  const stock = new Map(workspace.stock.map((board) => [board.id, board]));
  const requirements = new Map(
    workspace.requirements.map((requirement) => [requirement.id, requirement]),
  );
  const excluded = new Set(excludedStockIds);
  expect(new Set(solution.excludedStockIds)).toEqual(excluded);
  expect(solution.excludedStockIds.length).toBe(excluded.size);

  const usedBoards = new Set<string>();
  const produced = new Map<string, Set<number>>();
  let stockUsedMm = 0;
  let partsMm = 0;
  let kerfMm = 0;
  let reusableMm = 0;
  let scrapMm = 0;

  for (const layout of solution.layouts) {
    const board = stock.get(layout.stockId);
    if (!board) throw new Error(`Cut sheet references unknown stock ${layout.stockId}`);
    expect(board.locked).toBe(false);
    expect(excluded.has(board.id)).toBe(false);
    expect(usedBoards.has(board.id)).toBe(false);
    usedBoards.add(board.id);
    expect(layout.stockLabel).toBe(board.label);
    expect(layout.stockKind).toBe(board.kind);
    expect(layout.stockLengthMm).toBe(board.lengthMm);
    expect(layout.cuts.length).toBeGreaterThan(0);

    let offsetMm = 0;
    let boardPartsMm = 0;
    for (const cut of layout.cuts) {
      const requirement = requirements.get(cut.requirementId);
      if (!requirement)
        throw new Error(`Cut sheet references unknown requirement ${cut.requirementId}`);
      expect(cut.label).toBe(requirement.label);
      expect(cut.lengthMm).toBe(requirement.lengthMm);
      expect(cut.offsetMm).toBe(offsetMm);
      expect(Number.isInteger(cut.instance)).toBe(true);
      expect(cut.instance).toBeGreaterThanOrEqual(1);
      expect(cut.instance).toBeLessThanOrEqual(requirement.quantity);
      const instances = produced.get(requirement.id) ?? new Set<number>();
      expect(instances.has(cut.instance)).toBe(false);
      instances.add(cut.instance);
      produced.set(requirement.id, instances);
      boardPartsMm += cut.lengthMm;
      offsetMm += cut.lengthMm + workspace.settings.kerfMm;
    }

    const boardKerfMm = layout.cuts.length * workspace.settings.kerfMm;
    const remnantMm = board.lengthMm - offsetMm;
    expect(offsetMm).toBeLessThanOrEqual(board.lengthMm);
    expect(layout.kerfMm).toBe(boardKerfMm);
    expect(layout.remnantMm).toBe(remnantMm);
    expect(boardPartsMm + boardKerfMm + remnantMm).toBe(board.lengthMm);
    const remnantKind =
      remnantMm === 0
        ? 'none'
        : remnantMm >= workspace.settings.minReusableMm
          ? 'reusable'
          : 'scrap';
    expect(layout.remnantKind).toBe(remnantKind);
    stockUsedMm += board.lengthMm;
    partsMm += boardPartsMm;
    kerfMm += boardKerfMm;
    if (remnantKind === 'reusable') reusableMm += remnantMm;
    if (remnantKind === 'scrap') scrapMm += remnantMm;
  }

  expect(solution.metrics).toEqual({
    stockUsedMm,
    partsMm,
    kerfMm,
    reusableMm,
    scrapMm,
    boardCount: usedBoards.size,
    utilization: stockUsedMm === 0 ? 0 : partsMm / stockUsedMm,
  });
  expect(stockUsedMm).toBe(partsMm + kerfMm + reusableMm + scrapMm);

  const missing = new Map<string, number>();
  for (const item of solution.unfulfilled) {
    const requirement = requirements.get(item.requirementId);
    if (!requirement)
      throw new Error(`Missing quantity references unknown requirement ${item.requirementId}`);
    expect(missing.has(item.requirementId)).toBe(false);
    expect(item.label).toBe(requirement.label);
    expect(Number.isInteger(item.quantity)).toBe(true);
    expect(item.quantity).toBeGreaterThan(0);
    expect(item.quantity).toBeLessThanOrEqual(requirement.quantity);
    expect(typeof item.reason).toBe('string');
    expect(item.reason.trim().length).toBeGreaterThan(0);
    missing.set(item.requirementId, item.quantity);
  }
  for (const requirement of workspace.requirements) {
    const made = produced.get(requirement.id)?.size ?? 0;
    expect(made).toBeLessThanOrEqual(requirement.quantity);
    expect(made + (missing.get(requirement.id) ?? 0)).toBe(requirement.quantity);
  }
  expect(solution.complete).toBe(missing.size === 0);
  expect(Number.isSafeInteger(solution.search.nodes)).toBe(true);
  expect(solution.search.nodes).toBeGreaterThanOrEqual(0);
  expect(solution.search.limit).toBe(LIMITS.searchNodes);
  expect(solution.search.nodes).toBeLessThanOrEqual(solution.search.limit);
  if (solution.search.provenOptimal) {
    expect(solution.complete).toBe(true);
    expect(solution.search.nodes).toBeLessThan(solution.search.limit);
  }
}

function checkAgainstOracle(workspace: Workspace, excludedStockIds: string[] = []): OracleScores {
  const best = exhaustiveScores(workspace, excludedStockIds);
  for (const objective of OBJECTIVES) {
    const expectedScore = best[objective];
    let solution: PlanSolution | undefined;
    try {
      solution = solveUnchanged(workspace, objective, excludedStockIds);
      expectAccounting(workspace, solution, excludedStockIds);
      expect(solution.complete).toBe(expectedScore !== null);
      if (expectedScore !== null) expect(solutionScore(solution)).toEqual(expectedScore);
      // These exhaustive fixtures are far below the production search budget.
      expect(solution.search.nodes).toBeLessThan(solution.search.limit);
      expect(solution.search.provenOptimal).toBe(solution.complete);
    } catch (cause) {
      throw new Error(
        `Oracle disagreement for ${objective}: ${JSON.stringify(
          {
            workspace,
            excludedStockIds,
            expectedScore: best[objective],
            solution,
          },
          null,
          2,
        )}`,
        { cause },
      );
    }
  }
  return best;
}

function seededFixtures(): { workspace: Workspace; excludedStockIds: string[] }[] {
  // Preserve the 600-case executed smoke corpus; seed state is local to this generator.
  let seed = 0x57eb2026;
  const random = (maximum: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maximum;
  };
  return Array.from({ length: 600 }, (_, caseNumber) => {
    const stock: Workspace['stock'] = Array.from({ length: 1 + random(4) }, (_, index) => ({
      id: `b${index}`,
      label: `Board ${index}`,
      lengthMm: 8 + random(35),
      kind: index % 2 ? 'offcut' : 'board',
      locked: random(9) === 0,
    }));
    const requirements = Array.from({ length: 1 + random(5) }, (_, index) => ({
      id: `r${index}`,
      label: `Part ${index}`,
      lengthMm: 1 + random(21),
      quantity: index === 0 ? 1 + random(2) : 1,
    }));
    const settings = { kerfMm: random(4), minReusableMm: random(17) };
    const excludedStockIds = stock.filter(() => random(12) === 0).map((board) => board.id);
    return {
      workspace: {
        revision: 0,
        title: `Oracle seed 0x57eb2026 case ${caseNumber}`,
        material: 'Same cross-section',
        stock,
        requirements,
        settings,
      },
      excludedStockIds,
    };
  });
}

describe('independent exhaustive assignment oracle', () => {
  for (const { workspace, excludedStockIds } of seededFixtures()) {
    test(workspace.title, () => {
      checkAgainstOracle(workspace, excludedStockIds);
    });
  }
});

describe('lexicographic objective priorities', () => {
  const fixtures: {
    name: string;
    stock: number[];
    parts: RequirementInput[];
    settings: Workspace['settings'];
    scores: Record<Objective, Score>;
  }[] = [
    {
      name: 'all three objectives choose different stock/waste/handling tradeoffs',
      stock: [625, 625, 1300, 750, 750],
      parts: [[597, 2]],
      settings: { kerfMm: 3, minReusableMm: 150 },
      // Two 625s use least stock; one 1300 handles fewest boards; two 750s retain reusable ends.
      scores: {
        least_stock: [1250, 56, 2],
        fewest_boards: [1, 1300, 106],
        least_waste: [6, 1500, 2],
      },
    },
    {
      name: 'waste breaks equal-stock and equal-board-count ties',
      stock: [1000, 1000],
      parts: [
        [597, 1],
        [497, 1],
        [297, 1],
        [197, 2],
      ],
      settings: { kerfMm: 3, minReusableMm: 150 },
      // Consumed lengths group as (600+200+200)/(500+300), retaining a reusable 200 mm.
      scores: {
        least_stock: [2000, 15, 2],
        fewest_boards: [2, 2000, 15],
        least_waste: [15, 2000, 2],
      },
    },
    {
      name: 'stock breaks equal-waste and equal-board-count ties',
      stock: [700, 1000],
      parts: [[497, 1]],
      settings: { kerfMm: 3, minReusableMm: 100 },
      scores: { least_stock: [700, 3, 1], fewest_boards: [1, 700, 3], least_waste: [3, 700, 1] },
    },
    {
      name: 'board count breaks equal-stock and equal-waste ties',
      stock: [650, 650, 1300],
      parts: [[597, 2]],
      settings: { kerfMm: 3, minReusableMm: 2000 },
      scores: {
        least_stock: [1300, 106, 1],
        fewest_boards: [1, 1300, 106],
        least_waste: [106, 1300, 1],
      },
    },
  ];
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const workspace = makeWorkspace(fixture.stock, fixture.parts, fixture.settings);
      expect(checkAgainstOracle(workspace)).toEqual(fixture.scores);
    });
  }
});

describe('physical boundaries and identity accounting', () => {
  for (const partMm of [1000, 997]) {
    test(`${partMm} mm part on 1000 mm stock charges the final 3 mm kerf`, () => {
      const workspace = makeWorkspace([1000], [[partMm, 1]], { kerfMm: 3, minReusableMm: 0 });
      const solution = solveUnchanged(workspace, 'least_stock');
      expectAccounting(workspace, solution);
      expect(solution.complete).toBe(partMm === 997);
      expect(solution.metrics.partsMm).toBe(partMm === 997 ? 997 : 0);
      expect(solution.metrics.kerfMm).toBe(partMm === 997 ? 3 : 0);
      expect(solution.unfulfilled.map((item) => item.quantity)).toEqual(partMm === 997 ? [] : [1]);
    });
  }

  test('zero kerf permits an exact multi-part fill without sawdust', () => {
    const workspace = makeWorkspace(
      [1000],
      [
        [400, 1],
        [600, 1],
      ],
      { kerfMm: 0, minReusableMm: 0 },
    );
    const solution = solveUnchanged(workspace, 'least_waste');
    expectAccounting(workspace, solution);
    expect(solution.complete).toBe(true);
    expect(solution.metrics).toMatchObject({
      stockUsedMm: 1000,
      partsMm: 1000,
      kerfMm: 0,
      reusableMm: 0,
      scrapMm: 0,
    });
    expect(solution.layouts[0].remnantKind).toBe('none');
  });

  const remnantCases = [
    {
      name: 'positive remnant at threshold zero',
      partMm: 500,
      threshold: 0,
      remnantMm: 497,
      kind: 'reusable',
    },
    {
      name: 'zero remnant at threshold zero',
      partMm: 997,
      threshold: 0,
      remnantMm: 0,
      kind: 'none',
    },
    {
      name: 'exactly the reusable threshold',
      partMm: 897,
      threshold: 100,
      remnantMm: 100,
      kind: 'reusable',
    },
    {
      name: 'one millimetre below the reusable threshold',
      partMm: 898,
      threshold: 100,
      remnantMm: 99,
      kind: 'scrap',
    },
  ];
  for (const fixture of remnantCases) {
    test(fixture.name, () => {
      const workspace = makeWorkspace([1000], [[fixture.partMm, 1]], {
        kerfMm: 3,
        minReusableMm: fixture.threshold,
      });
      const solution = solveUnchanged(workspace, 'least_waste');
      expectAccounting(workspace, solution);
      expect(solution.complete).toBe(true);
      expect(solution.layouts[0]).toMatchObject({
        remnantMm: fixture.remnantMm,
        remnantKind: fixture.kind,
      });
      expect(solution.metrics.reusableMm).toBe(fixture.kind === 'reusable' ? fixture.remnantMm : 0);
      expect(solution.metrics.scrapMm).toBe(fixture.kind === 'scrap' ? fixture.remnantMm : 0);
    });
  }

  test('finite identical stock respects human locks plus additional, duplicate exclusions', () => {
    const workspace = makeWorkspace([1000, 1000, 1000, 1000], [[997, 3]], {
      kerfMm: 3,
      minReusableMm: 100,
    });
    workspace.stock[0].locked = true;
    workspace.stock[3].kind = 'offcut';
    const excludedStockIds = [workspace.stock[1].id, workspace.stock[0].id, workspace.stock[1].id];
    expect(checkAgainstOracle(workspace, excludedStockIds)).toEqual({
      least_stock: null,
      fewest_boards: null,
      least_waste: null,
    });
    for (const objective of OBJECTIVES) {
      const partial = solveUnchanged(workspace, objective, excludedStockIds);
      expectAccounting(workspace, partial, excludedStockIds);
      expect(partial.metrics.boardCount).toBe(2);
      expect(partial.unfulfilled.map((item) => item.quantity)).toEqual([1]);
      const withoutAdditionalExclusions = solveUnchanged(workspace, objective);
      expectAccounting(workspace, withoutAdditionalExclusions);
      expect(withoutAdditionalExclusions.complete).toBe(true);
      expect(withoutAdditionalExclusions.metrics.boardCount).toBe(3);
    }
  });

  for (const stockLengths of [[1000, 500], [1000]]) {
    test(`equal-length requirements keep separate IDs, labels and instances on ${stockLengths.length} boards`, () => {
      const workspace = makeWorkspace(
        stockLengths,
        [
          [497, 2],
          [497, 1],
        ],
        { kerfMm: 3, minReusableMm: 100 },
      );
      workspace.requirements[0].id = 'shelf';
      workspace.requirements[0].label = 'Shelf';
      workspace.requirements[1].id = 'rail';
      workspace.requirements[1].label = 'Rail';
      const scores = checkAgainstOracle(workspace);
      expect(scores.least_stock !== null).toBe(stockLengths.length === 2);
    });
  }

  test('frozen, unsorted inputs can be validated and solved repeatedly without mutation', () => {
    const workspace = makeWorkspace(
      [1000, 1500, 500, 800],
      [
        [197, 1],
        [497, 2],
        [297, 1],
      ],
      { kerfMm: 3, minReusableMm: 100 },
    );
    workspace.stock[3].locked = true;
    const excludedStockIds = [workspace.stock[2].id, workspace.stock[3].id, workspace.stock[2].id];
    const before = structuredClone(workspace);
    for (const board of workspace.stock) Object.freeze(board);
    for (const requirement of workspace.requirements) Object.freeze(requirement);
    Object.freeze(workspace.stock);
    Object.freeze(workspace.requirements);
    Object.freeze(workspace.settings);
    Object.freeze(workspace);
    Object.freeze(excludedStockIds);
    validateWorkspace(workspace);
    expect(workspace).toEqual(before);
    for (const objective of OBJECTIVES) {
      const solution = solveUnchanged(workspace, objective, excludedStockIds);
      expectAccounting(workspace, solution, excludedStockIds);
      expect(solution.complete).toBe(true);
      expect(solveUnchanged(workspace, objective, excludedStockIds)).toEqual(solution);
    }
  });

  test('aggregate stock cannot satisfy an individually oversized part', () => {
    const workspace = makeWorkspace([600, 600], [[700, 1]], { kerfMm: 3, minReusableMm: 0 });
    expect(checkAgainstOracle(workspace)).toEqual({
      least_stock: null,
      fewest_boards: null,
      least_waste: null,
    });
    const solution = solveUnchanged(workspace, 'least_stock');
    expect(solution.layouts).toEqual([]);
    expect(solution.unfulfilled).toMatchObject([
      { requirementId: workspace.requirements[0].id, quantity: 1 },
    ]);
  });

  test('partial plans report every missing quantity and only account for produced cuts', () => {
    const workspace = makeWorkspace(
      [1000],
      [
        [497, 3],
        [2000, 1],
      ],
      { kerfMm: 3, minReusableMm: 100 },
    );
    for (const objective of OBJECTIVES) {
      const solution = solveUnchanged(workspace, objective);
      expectAccounting(workspace, solution);
      expect(solution.complete).toBe(false);
      expect(solution.search.provenOptimal).toBe(false);
      expect(
        new Map(solution.unfulfilled.map((item) => [item.requirementId, item.quantity])),
      ).toEqual(new Map(workspace.requirements.map((requirement) => [requirement.id, 1])));
      expect(solution.metrics).toMatchObject({
        stockUsedMm: 1000,
        partsMm: 994,
        kerfMm: 6,
        reusableMm: 0,
        scrapMm: 0,
        boardCount: 1,
      });
    }
  });

  for (const unavailable of ['empty', 'locked', 'excluded'] as const) {
    test(`${unavailable} stock returns explicit misses, not a complete empty plan`, () => {
      const workspace = makeWorkspace(unavailable === 'empty' ? [] : [1000], [[197, 2]], {
        kerfMm: 3,
        minReusableMm: 100,
      });
      if (unavailable === 'locked') workspace.stock[0].locked = true;
      const excludedStockIds = unavailable === 'excluded' ? [workspace.stock[0].id] : [];
      validateWorkspace(workspace);
      const solution = solveUnchanged(workspace, 'fewest_boards', excludedStockIds);
      expectAccounting(workspace, solution, excludedStockIds);
      expect(solution.complete).toBe(false);
      expect(solution.layouts).toEqual([]);
      expect(solution.unfulfilled).toMatchObject([
        { requirementId: workspace.requirements[0].id, quantity: 2 },
      ]);
    });
  }
});

describe('bounded search confidence and recovery', () => {
  for (const objective of OBJECTIVES) {
    test(`the executed 40-part/24-board fixture reaches 100000 nodes without claiming optimality: ${objective}`, () => {
      const workspace = makeWorkspace(
        new Array<number>(24).fill(2400),
        [300, 440, 580, 620, 710, 830, 950, 1020, 1140, 1270].map(
          (lengthMm) => [lengthMm, 4] as const,
        ),
        { kerfMm: 3, minReusableMm: 400 },
      );
      const solution = solveUnchanged(workspace, objective);
      expectAccounting(workspace, solution);
      expect(solution.complete).toBe(true);
      expect(solution.metrics.partsMm).toBe(31_440);
      expect(solution.metrics.kerfMm).toBe(120);
      expect(solution.search.limit).toBe(100_000);
      expect(solution.search.nodes).toBe(solution.search.limit);
      expect(solution.search.provenOptimal).toBe(false);
    });

    test(`search recovers the positive-kerf first-fit counterexample on two 1010 mm boards: ${objective}`, () => {
      const workspace = makeWorkspace(
        [1010, 1010],
        [
          [600, 1],
          [500, 1],
          [294, 1],
          [200, 2],
          [194, 1],
        ],
        { kerfMm: 3, minReusableMm: 100 },
      );
      // First fit strands 194+3 after [600,294] / [500,200,200].
      // A complete arrangement is [600,200,200] / [500,294,194].
      const best = exhaustiveScores(workspace, []);
      const expectedScore = best[objective];
      if (expectedScore === null)
        throw new Error('Expected a complete exhaustive recovery layout.');
      const solution = solveUnchanged(workspace, objective);
      expectAccounting(workspace, solution);
      expect(solution.complete).toBe(true);
      expect(solutionScore(solution)).toEqual(expectedScore);
      expect(solution.metrics).toEqual({
        stockUsedMm: 2020,
        partsMm: 1988,
        kerfMm: 18,
        reusableMm: 0,
        scrapMm: 14,
        boardCount: 2,
        utilization: 1988 / 2020,
      });
      expect(solution.search.provenOptimal).toBe(true);
    });
  }
});

function expectPlannerError(action: () => unknown, code: string, field?: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkshopError);
    if (!(error instanceof WorkshopError)) throw error;
    expect(error.code).toBe(code);
    expect(error.message.trim().length).toBeGreaterThan(0);
    if (field !== undefined) expect(error.details).toEqual({ field });
    return;
  }
  throw new Error(`Expected ${code}${field === undefined ? '' : ` for ${field}`}`);
}

function validationWorkspace(): Workspace {
  return makeWorkspace([1000], [[400, 1]], { kerfMm: 3, minReusableMm: 100 });
}

function expectInvalidWorkspace(input: unknown, field: string): void {
  const before = structuredClone(input);
  expectPlannerError(() => validateWorkspace(input as Workspace), 'INVALID_WORKSPACE', field);
  expectPlannerError(
    () => solveCutPlan(input as Workspace, 'least_stock'),
    'INVALID_WORKSPACE',
    field,
  );
  expect(input).toEqual(before);
}

describe('workspace and request validation', () => {
  for (const stockLengths of [[], [1000]]) {
    test(`an empty job with ${stockLengths.length} boards is valid to edit but cannot be solved`, () => {
      const workspace = makeWorkspace(stockLengths, [], { kerfMm: 0, minReusableMm: 0 });
      validateWorkspace(workspace);
      for (const objective of OBJECTIVES)
        expectPlannerError(() => solveCutPlan(workspace, objective), 'NO_REQUIREMENTS');
    });
  }

  const numericFields: {
    name: string;
    field: string;
    minimum: number;
    maximum: number;
    set: (workspace: Workspace, value: number) => void;
  }[] = [
    {
      name: 'revision',
      field: 'Workspace revision',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      set: (workspace, value) => {
        workspace.revision = value;
      },
    },
    {
      name: 'kerf',
      field: 'Kerf (mm)',
      minimum: 0,
      maximum: LIMITS.kerfMm,
      set: (workspace, value) => {
        workspace.settings.kerfMm = value;
      },
    },
    {
      name: 'reusable threshold',
      field: 'Minimum reusable remnant (mm)',
      minimum: 0,
      maximum: LIMITS.lengthMm,
      set: (workspace, value) => {
        workspace.settings.minReusableMm = value;
      },
    },
    {
      name: 'stock length',
      field: 'Stock 1 usable length (mm)',
      minimum: 1,
      maximum: LIMITS.lengthMm,
      set: (workspace, value) => {
        workspace.stock[0].lengthMm = value;
      },
    },
    {
      name: 'part length',
      field: 'Requirement 1 length (mm)',
      minimum: 1,
      maximum: LIMITS.lengthMm,
      set: (workspace, value) => {
        workspace.requirements[0].lengthMm = value;
      },
    },
    {
      name: 'quantity',
      field: 'Requirement 1 quantity',
      minimum: 1,
      maximum: LIMITS.totalParts,
      set: (workspace, value) => {
        workspace.requirements[0].quantity = value;
      },
    },
  ];
  for (const field of numericFields) {
    const invalidValues = [
      { name: 'NaN', value: NaN },
      { name: 'positive infinity', value: Infinity },
      { name: 'negative infinity', value: -Infinity },
      { name: 'fractional millimetres/count', value: 1.5 },
      { name: 'below minimum', value: field.minimum - 1 },
      { name: 'above maximum', value: field.maximum + 1 },
      { name: 'numeric text', value: '3' },
      { name: 'missing value', value: undefined },
    ];
    for (const invalid of invalidValues) {
      test(`${field.name} rejects ${invalid.name}`, () => {
        const workspace = validationWorkspace();
        // Deliberately cross the typed boundary, as malformed persisted/native input can.
        field.set(workspace, invalid.value as number);
        expectInvalidWorkspace(workspace, field.field);
      });
    }
    test(`${field.name} accepts its inclusive endpoints`, () => {
      for (const value of [field.minimum, field.maximum]) {
        const workspace = validationWorkspace();
        field.set(workspace, value);
        validateWorkspace(workspace);
      }
    });
  }

  const textFields: {
    name: string;
    field: string;
    maximum: number;
    identifier: boolean;
    set: (workspace: Workspace, value: string) => void;
  }[] = [
    {
      name: 'title',
      field: 'Project title',
      maximum: 100,
      identifier: false,
      set: (workspace, value) => {
        workspace.title = value;
      },
    },
    {
      name: 'material',
      field: 'Material',
      maximum: 100,
      identifier: false,
      set: (workspace, value) => {
        workspace.material = value;
      },
    },
    {
      name: 'stock ID',
      field: 'Stock 1 ID',
      maximum: 64,
      identifier: true,
      set: (workspace, value) => {
        workspace.stock[0].id = value;
      },
    },
    {
      name: 'stock label',
      field: 'Stock 1 label',
      maximum: 80,
      identifier: false,
      set: (workspace, value) => {
        workspace.stock[0].label = value;
      },
    },
    {
      name: 'requirement ID',
      field: 'Requirement 1 ID',
      maximum: 64,
      identifier: true,
      set: (workspace, value) => {
        workspace.requirements[0].id = value;
      },
    },
    {
      name: 'requirement label',
      field: 'Requirement 1 label',
      maximum: 80,
      identifier: false,
      set: (workspace, value) => {
        workspace.requirements[0].label = value;
      },
    },
  ];
  for (const field of textFields) {
    const invalidValues = [
      { name: 'blank text', value: '' },
      { name: 'whitespace only', value: '   ' },
      { name: 'line break', value: 'two\nlines' },
      { name: 'control character', value: 'bad\u0000text' },
      { name: 'Unicode line separator', value: 'two\u2028lines' },
      { name: 'overlong text', value: 'x'.repeat(field.maximum + 1) },
      { name: 'nontext value', value: 123 },
      ...(field.identifier ? [{ name: 'padded identifier', value: ' padded ' }] : []),
    ];
    for (const invalid of invalidValues) {
      test(`${field.name} rejects ${invalid.name}`, () => {
        const workspace = validationWorkspace();
        field.set(workspace, invalid.value as string);
        expectInvalidWorkspace(workspace, field.field);
      });
    }
    test(`${field.name} accepts text at its length limit`, () => {
      const workspace = validationWorkspace();
      field.set(workspace, 'x'.repeat(field.maximum));
      validateWorkspace(workspace);
    });
  }

  const malformed: { name: string; input: () => unknown; field: string }[] = [
    { name: 'null workspace', input: () => null, field: 'Workspace' },
    { name: 'array workspace', input: () => [], field: 'Workspace' },
    { name: 'missing workspace fields', input: () => ({}), field: 'Workspace revision' },
    {
      name: 'null settings',
      input: () => ({ ...validationWorkspace(), settings: null }),
      field: 'Planner settings',
    },
    {
      name: 'array settings',
      input: () => ({ ...validationWorkspace(), settings: [] }),
      field: 'Planner settings',
    },
    {
      name: 'non-array stock',
      input: () => ({ ...validationWorkspace(), stock: {} }),
      field: 'Stock',
    },
    {
      name: 'non-array requirements',
      input: () => ({ ...validationWorkspace(), requirements: null }),
      field: 'Requirements',
    },
    {
      name: 'null stock entry',
      input: () => ({ ...validationWorkspace(), stock: [null] }),
      field: 'Stock 1',
    },
    {
      name: 'array requirement entry',
      input: () => ({ ...validationWorkspace(), requirements: [[]] }),
      field: 'Requirement 1',
    },
    {
      name: 'invalid stock kind',
      input: () => {
        const workspace = validationWorkspace();
        return { ...workspace, stock: [{ ...workspace.stock[0], kind: 'sheet' }] };
      },
      field: 'Stock 1 kind',
    },
    {
      name: 'nonboolean protection',
      input: () => {
        const workspace = validationWorkspace();
        return { ...workspace, stock: [{ ...workspace.stock[0], locked: 'false' }] };
      },
      field: 'Stock 1 protection',
    },
    {
      name: 'duplicate stock ID',
      input: () => {
        const workspace = validationWorkspace();
        workspace.stock.push({ ...workspace.stock[0] });
        return workspace;
      },
      field: 'Stock 2 ID',
    },
    {
      name: 'duplicate requirement ID',
      input: () => {
        const workspace = validationWorkspace();
        workspace.requirements.push({ ...workspace.requirements[0] });
        return workspace;
      },
      field: 'Requirement 2 ID',
    },
    {
      name: 'too many physical boards',
      input: () =>
        makeWorkspace(new Array<number>(LIMITS.stockBoards + 1).fill(1000), [[400, 1]], {
          kerfMm: 3,
          minReusableMm: 100,
        }),
      field: 'Stock',
    },
    {
      name: 'too many requirement IDs',
      input: () =>
        makeWorkspace(
          [1000],
          Array.from({ length: LIMITS.requirements + 1 }, () => [1, 1] as const),
          { kerfMm: 0, minReusableMm: 0 },
        ),
      field: 'Requirements',
    },
    {
      name: 'aggregate quantity over the limit',
      input: () =>
        makeWorkspace(
          [1000],
          [
            [1, LIMITS.totalParts],
            [2, 1],
          ],
          { kerfMm: 0, minReusableMm: 0 },
        ),
      field: 'Requested quantity',
    },
  ];
  for (const fixture of malformed) {
    test(`rejects ${fixture.name} with a field-specific error`, () => {
      expectInvalidWorkspace(fixture.input(), fixture.field);
    });
  }

  test('all collection and measurement limits are inclusive, not silently truncated', () => {
    const workspace = makeWorkspace(
      new Array<number>(LIMITS.stockBoards).fill(LIMITS.lengthMm),
      Array.from(
        { length: LIMITS.requirements },
        (_, index) =>
          [LIMITS.lengthMm, index === 0 ? LIMITS.totalParts - LIMITS.requirements + 1 : 1] as const,
      ),
      { kerfMm: LIMITS.kerfMm, minReusableMm: LIMITS.lengthMm },
    );
    workspace.revision = Number.MAX_SAFE_INTEGER;
    const before = structuredClone(workspace);
    validateWorkspace(workspace);
    expect(workspace).toEqual(before);
  });

  test('unknown objectives and malformed or unknown exclusions fail explicitly', () => {
    const workspace = validationWorkspace();
    const before = structuredClone(workspace);
    for (const objective of ['fastest', null, undefined]) {
      expectPlannerError(
        () => solveCutPlan(workspace, objective as Objective),
        'INVALID_OBJECTIVE',
      );
    }
    for (const excludedStockIds of [null, workspace.stock[0].id, [123]]) {
      expectPlannerError(
        () => solveCutPlan(workspace, 'least_stock', excludedStockIds as unknown as string[]),
        'INVALID_EXCLUSIONS',
      );
    }
    expectPlannerError(
      () => solveCutPlan(workspace, 'least_stock', ['not-in-this-workspace']),
      'UNKNOWN_STOCK',
    );
    expect(workspace).toEqual(before);
  });
});
