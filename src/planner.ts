import { WorkshopError } from './errors';
import {
  LIMITS,
  type BoardLayout,
  type Objective,
  type PlanSolution,
  type StockBoard,
  type Workspace,
} from './types';

function invalidWorkspace(field: string, message: string): never {
  throw new WorkshopError('INVALID_WORKSPACE', `${field} ${message}`, { field });
}

function validateObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidWorkspace(field, 'must be an object.');
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function validateText(value: unknown, field: string, maximum: number, identifier = false): void {
  if (typeof value !== 'string') invalidWorkspace(field, 'must be text.');
  if (value.length > maximum) invalidWorkspace(field, `must be at most ${maximum} characters.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) invalidWorkspace(field, 'must not be blank.');
  if (CONTROL_CHARACTERS.test(value))
    invalidWorkspace(field, 'must not contain control characters or line breaks.');
  if (identifier && value !== trimmed)
    invalidWorkspace(field, 'must not have leading or trailing whitespace.');
}

function validateInteger(value: unknown, field: string, minimum: number, maximum: number): void {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalidWorkspace(field, `must be an integer from ${minimum} to ${maximum}.`);
  }
}

export function validateWorkspace(workspace: Workspace): void {
  validateObject(workspace, 'Workspace');
  validateInteger(workspace.revision, 'Workspace revision', 0, Number.MAX_SAFE_INTEGER);
  validateText(workspace.title, 'Project title', 100);
  validateText(workspace.material, 'Material', 100);
  validateObject(workspace.settings, 'Planner settings');
  validateInteger(workspace.settings.kerfMm, 'Kerf (mm)', 0, LIMITS.kerfMm);
  validateInteger(
    workspace.settings.minReusableMm,
    'Minimum reusable remnant (mm)',
    0,
    LIMITS.lengthMm,
  );

  if (!Array.isArray(workspace.stock)) invalidWorkspace('Stock', 'must be an array.');
  if (workspace.stock.length > LIMITS.stockBoards) {
    invalidWorkspace('Stock', `must contain at most ${LIMITS.stockBoards} boards.`);
  }
  if (!Array.isArray(workspace.requirements)) invalidWorkspace('Requirements', 'must be an array.');
  if (workspace.requirements.length > LIMITS.requirements) {
    invalidWorkspace(
      'Requirements',
      `must contain at most ${LIMITS.requirements} distinct entries.`,
    );
  }

  const stockIds = new Set<string>();
  for (let index = 0; index < workspace.stock.length; index++) {
    const board = workspace.stock[index];
    const field = `Stock ${index + 1}`;
    validateObject(board, field);
    validateText(board.id, `${field} ID`, 64, true);
    validateText(board.label, `${field} label`, 80);
    validateInteger(board.lengthMm, `${field} usable length (mm)`, 1, LIMITS.lengthMm);
    if (board.kind !== 'board' && board.kind !== 'offcut') {
      invalidWorkspace(`${field} kind`, 'must be board or offcut.');
    }
    if (typeof board.locked !== 'boolean')
      invalidWorkspace(`${field} protection`, 'must be true or false.');
    if (stockIds.has(board.id)) invalidWorkspace(`${field} ID`, 'duplicates another stock ID.');
    stockIds.add(board.id);
  }

  const requirementIds = new Set<string>();
  let totalParts = 0;
  for (let index = 0; index < workspace.requirements.length; index++) {
    const requirement = workspace.requirements[index];
    const field = `Requirement ${index + 1}`;
    validateObject(requirement, field);
    validateText(requirement.id, `${field} ID`, 64, true);
    validateText(requirement.label, `${field} label`, 80);
    validateInteger(requirement.lengthMm, `${field} length (mm)`, 1, LIMITS.lengthMm);
    validateInteger(requirement.quantity, `${field} quantity`, 1, LIMITS.totalParts);
    if (requirementIds.has(requirement.id))
      invalidWorkspace(`${field} ID`, 'duplicates another requirement ID.');
    requirementIds.add(requirement.id);
    totalParts += requirement.quantity;
  }
  if (totalParts > LIMITS.totalParts) {
    invalidWorkspace('Requested quantity', `must total at most ${LIMITS.totalParts} parts.`);
  }
}

interface Part {
  requirementIndex: number;
  instance: number;
  consumedMm: number;
}

export function solveCutPlan(
  workspace: Workspace,
  objective: Objective,
  excludedStockIds: string[] = [],
): PlanSolution {
  validateWorkspace(workspace);
  if (objective !== 'least_stock' && objective !== 'fewest_boards' && objective !== 'least_waste') {
    throw new WorkshopError(
      'INVALID_OBJECTIVE',
      'Choose least_stock, fewest_boards or least_waste.',
    );
  }
  if (!Array.isArray(excludedStockIds)) {
    throw new WorkshopError(
      'INVALID_EXCLUSIONS',
      'Excluded stock IDs must be an array of strings.',
    );
  }
  const stockIds = new Set<string>();
  for (const board of workspace.stock) stockIds.add(board.id);
  const exclusions = new Set<string>();
  for (const id of excludedStockIds) {
    if (typeof id !== 'string') {
      throw new WorkshopError('INVALID_EXCLUSIONS', 'Every excluded stock ID must be a string.');
    }
    if (!stockIds.has(id)) {
      throw new WorkshopError(
        'UNKNOWN_STOCK',
        `Excluded stock ID "${id}" is not in this workspace.`,
        { stockId: id },
      );
    }
    exclusions.add(id);
  }
  if (workspace.requirements.length === 0) {
    throw new WorkshopError(
      'NO_REQUIREMENTS',
      'Add at least one required part before finding a cutting plan.',
    );
  }

  const boards: StockBoard[] = [];
  const canonicalExclusions: string[] = [];
  for (const board of workspace.stock) {
    if (exclusions.has(board.id)) canonicalExclusions.push(board.id);
    if (!board.locked && !exclusions.has(board.id)) boards.push(board);
  }
  // Stable length order supplies a fixed identity order for identical-part symmetry.
  boards.sort((left, right) => left.lengthMm - right.lengthMm);
  const kerf = workspace.settings.kerfMm;
  const reusableThreshold = workspace.settings.minReusableMm;
  const parts: Part[] = [];
  for (let index = 0; index < workspace.requirements.length; index++) {
    const requirement = workspace.requirements[index];
    for (let instance = 1; instance <= requirement.quantity; instance++) {
      parts.push({ requirementIndex: index, instance, consumedMm: requirement.lengthMm + kerf });
    }
  }
  parts.sort(
    (left, right) =>
      right.consumedMm - left.consumedMm ||
      left.requirementIndex - right.requirementIndex ||
      left.instance - right.instance,
  );

  const partCount = parts.length;
  const boardCount = boards.length;
  const lengths = new Int32Array(boardCount);
  let eligibleStockMm = 0;
  for (let index = 0; index < boardCount; index++) {
    lengths[index] = boards[index].lengthMm;
    eligibleStockMm += lengths[index];
  }
  const remaining = new Int32Array(lengths);
  const uses = new Uint8Array(boardCount);
  const assignment = new Int16Array(partCount).fill(-1);
  const bestComplete = new Int16Array(partCount).fill(-1);
  const bestPartial = new Int16Array(partCount).fill(-1);
  const suffixDemand = new Int32Array(partCount + 1);
  const suffixGcd = new Int32Array(partCount + 1);
  const groupEnd = new Uint8Array(partCount);
  for (let index = partCount - 1; index >= 0; index--) {
    const cost = parts[index].consumedMm;
    suffixDemand[index] = suffixDemand[index + 1] + cost;
    groupEnd[index] =
      index + 1 < partCount && cost === parts[index + 1].consumedMm
        ? groupEnd[index + 1]
        : index + 1;
    let divisor = cost;
    let other = suffixGcd[index + 1];
    while (other !== 0) {
      const remainder = divisor % other;
      divisor = other;
      other = remainder;
    }
    suffixGcd[index] = divisor;
  }
  const totalDemandMm = suffixDemand[0];
  const totalKerfMm = partCount * kerf;
  const totalPartsMm = totalDemandMm - totalKerfMm;
  const smallestCost = parts[partCount - 1].consumedMm;
  let hasComplete = false;
  let bestStockMm = Infinity;
  let bestWasteMm = Infinity;
  let bestBoards = Infinity;
  let partialCount = 0;
  let partialPartsMm = 0;
  let partialStockMm = 0;
  let partialWasteMm = 0;
  let partialBoards = 0;

  function compareScore(
    stock: number,
    waste: number,
    count: number,
    otherStock: number,
    otherWaste: number,
    otherCount: number,
  ): number {
    if (objective === 'least_stock')
      return stock - otherStock || waste - otherWaste || count - otherCount;
    if (objective === 'fewest_boards')
      return count - otherCount || stock - otherStock || waste - otherWaste;
    return waste - otherWaste || stock - otherStock || count - otherCount;
  }

  function rememberCandidate(
    produced: number,
    producedMm: number,
    stockMm: number,
    count: number,
  ): void {
    const complete = produced === partCount;
    if (
      !complete &&
      (hasComplete ||
        produced < partialCount ||
        (produced === partialCount && producedMm < partialPartsMm))
    )
      return;
    // Reject only score prefixes that are already strictly worse. Tied prefixes
    // still need the waste scan, and least_waste has no known prefix yet.
    if (complete && hasComplete) {
      if (objective === 'least_stock' && stockMm > bestStockMm) return;
      if (
        objective === 'fewest_boards' &&
        (count > bestBoards || (count === bestBoards && stockMm > bestStockMm))
      )
        return;
    }
    let wasteMm = produced * kerf;
    for (let index = 0; index < boardCount; index++) {
      if (uses[index] !== 0 && remaining[index] < reusableThreshold) wasteMm += remaining[index];
    }
    if (complete) {
      if (
        hasComplete &&
        compareScore(stockMm, wasteMm, count, bestStockMm, bestWasteMm, bestBoards) >= 0
      )
        return;
      bestComplete.set(assignment);
      hasComplete = true;
      bestStockMm = stockMm;
      bestWasteMm = wasteMm;
      bestBoards = count;
    } else {
      if (
        produced === partialCount &&
        producedMm === partialPartsMm &&
        compareScore(stockMm, wasteMm, count, partialStockMm, partialWasteMm, partialBoards) >= 0
      )
        return;
      bestPartial.set(assignment);
      partialCount = produced;
      partialPartsMm = producedMm;
      partialStockMm = stockMm;
      partialWasteMm = wasteMm;
      partialBoards = count;
    }
  }

  // Four deterministic seeds: reuse/tight fit, reuse/long stock, marginal scrap,
  // and global tight fit. These are feasible incumbents, never optimality proofs.
  function comparePlacement(left: number, right: number, cost: number, mode: number): number {
    const leftNew = uses[left] === 0 ? 1 : 0;
    const rightNew = uses[right] === 0 ? 1 : 0;
    if (mode === 2) {
      const leftAfter = remaining[left] - cost;
      const rightAfter = remaining[right] - cost;
      const leftDelta =
        (leftAfter < reusableThreshold ? leftAfter : 0) -
        (leftNew === 0 && remaining[left] < reusableThreshold ? remaining[left] : 0);
      const rightDelta =
        (rightAfter < reusableThreshold ? rightAfter : 0) -
        (rightNew === 0 && remaining[right] < reusableThreshold ? remaining[right] : 0);
      return (
        leftDelta - rightDelta ||
        leftNew * lengths[left] - rightNew * lengths[right] ||
        leftNew - rightNew ||
        remaining[left] - remaining[right] ||
        left - right
      );
    }
    if (mode === 3) return remaining[left] - remaining[right] || leftNew - rightNew || left - right;
    return (
      leftNew - rightNew ||
      (mode === 1 && leftNew !== 0
        ? remaining[right] - remaining[left]
        : remaining[left] - remaining[right]) ||
      left - right
    );
  }

  for (let mode = 0; mode < 4; mode++) {
    remaining.set(lengths);
    uses.fill(0);
    assignment.fill(-1);
    let usedStock = 0;
    let usedBoards = 0;
    let produced = 0;
    let producedMm = 0;
    for (let index = 0; index < partCount; index++) {
      const cost = parts[index].consumedMm;
      let target = -1;
      for (let board = 0; board < boardCount; board++) {
        if (
          remaining[board] >= cost &&
          (target === -1 || comparePlacement(board, target, cost, mode) < 0)
        )
          target = board;
      }
      if (target === -1) continue;
      if (uses[target] === 0) {
        usedStock += lengths[target];
        usedBoards++;
      }
      uses[target]++;
      remaining[target] -= cost;
      assignment[index] = target;
      produced++;
      producedMm += cost - kerf;
    }
    rememberCandidate(produced, producedMm, usedStock, usedBoards);
  }

  remaining.set(lengths);
  uses.fill(0);
  assignment.fill(-1);
  // Each depth borrows its own candidate slice; no heap allocation per node.
  const candidates = new Int16Array(partCount * boardCount);
  const searchMode = objective === 'fewest_boards' ? 1 : objective === 'least_waste' ? 2 : 0;
  let nodes = 0;
  let stoppedAtLimit = false;

  function search(depth: number, usedStock: number, usedBoards: number): void {
    if (nodes >= LIMITS.searchNodes) {
      stoppedAtLimit = true;
      return;
    }
    nodes++;
    if (depth === partCount) {
      rememberCandidate(partCount, totalPartsMm, usedStock, usedBoards);
      return;
    }
    if (!hasComplete)
      rememberCandidate(
        depth,
        totalDemandMm - suffixDemand[depth] - depth * kerf,
        usedStock,
        usedBoards,
      );
    const cost = parts[depth].consumedMm;
    // Equal-size instances (even from different requirements) are interchangeable.
    // Nondecreasing destinations enumerate each multiset of placements only once.
    const minimumBoard =
      depth !== 0 && parts[depth - 1].consumedMm === cost ? assignment[depth - 1] : 0;
    const groupQuantity = groupEnd[depth] - depth;
    const gcd = suffixGcd[depth];
    let capacity = 0;
    let openCapacity = 0;
    let partSlots = 0;
    let groupSlots = 0;
    let openGroupSlots = 0;
    let unavoidableScrap = 0;
    let reusablePossible = false;
    for (let board = 0; board < boardCount; board++) {
      const residual = remaining[board];
      const open = uses[board] !== 0;
      let uncuttableMm = residual;
      if (residual >= smallestCost) {
        // Future consumption on each board is a multiple of the suffix GCD.
        uncuttableMm = gcd === 1 ? 0 : residual % gcd;
        const roundedCapacity = residual - uncuttableMm;
        capacity += roundedCapacity;
        if (open) openCapacity += roundedCapacity;
        // Every remaining part costs at least smallestCost; ignore group restrictions.
        partSlots += Math.floor(residual / smallestCost);
      }
      const slots = board >= minimumBoard ? Math.floor(residual / cost) : 0;
      groupSlots += slots;
      if (open) {
        openGroupSlots += slots;
        // Current scrap can still be cut away: never use it wholesale as a bound.
        // An uncuttable remnant is fixed; a short cuttable one cannot fall below
        // residual mod gcd(remaining cut lengths INCLUDING their kerfs).
        if (residual < reusableThreshold) {
          unavoidableScrap += uncuttableMm;
        }
        if (residual > 0 && residual >= reusableThreshold) reusablePossible = true;
      } else if (residual > smallestCost && residual - smallestCost >= reusableThreshold) {
        reusablePossible = true;
      }
    }
    if (
      suffixDemand[depth] > capacity ||
      partCount - depth > partSlots ||
      groupQuantity > groupSlots
    )
      return;

    if (hasComplete) {
      const neededCapacity = Math.max(0, suffixDemand[depth] - openCapacity);
      const neededSlots = Math.max(0, groupQuantity - openGroupSlots);
      let additionalBoards = 0;
      let largestCapacity = 0;
      let largestSlots = 0;
      // The k longest unopened boards maximize rounded capacity and equal-part slots.
      // Both stay monotone in length, including the group's minimum-board cutoff.
      // Even this optimistic packing must satisfy both necessary conditions.
      for (
        let board = boardCount - 1;
        board >= 0 && (largestCapacity < neededCapacity || largestSlots < neededSlots);
        board--
      ) {
        if (uses[board] !== 0 || lengths[board] < smallestCost) continue;
        additionalBoards++;
        largestCapacity += gcd === 1 ? lengths[board] : lengths[board] - (lengths[board] % gcd);
        if (board >= minimumBoard) largestSlots += Math.floor(lengths[board] / cost);
      }
      let shortestStock = 0;
      let selectedBoards = 0;
      for (let board = 0; board < boardCount && selectedBoards < additionalBoards; board++) {
        if (uses[board] !== 0 || lengths[board] < smallestCost) continue;
        shortestStock += lengths[board];
        selectedBoards++;
      }
      const stockBound = usedStock + Math.max(neededCapacity, shortestStock);
      let wasteBound = totalKerfMm + unavoidableScrap;
      if (!reusablePossible) wasteBound = Math.max(wasteBound, stockBound - totalPartsMm);
      const countBound = usedBoards + additionalBoards;
      // Componentwise lower bounds are valid under every lexicographic objective.
      // Equality is also prunable: there is no need to enumerate tied layouts.
      if (
        compareScore(stockBound, wasteBound, countBound, bestStockMm, bestWasteMm, bestBoards) >= 0
      )
        return;
    }

    const base = depth * boardCount;
    let candidateCount = 0;
    for (let board = minimumBoard; board < boardCount; board++) {
      if (remaining[board] < cost) continue;
      let equivalent = false;
      for (let index = 0; index < candidateCount; index++) {
        const other = candidates[base + index];
        if (remaining[board] === remaining[other] && (uses[board] === 0) === (uses[other] === 0)) {
          equivalent = true;
          break;
        }
      }
      // Equal residuals of already-open boards can exchange all future cuts;
      // equal empty boards are interchangeable too. Never merge open with empty.
      // Ascending enumeration keeps the lowest identity, preserving run ordering.
      if (equivalent) continue;
      let position = candidateCount;
      while (
        position > 0 &&
        comparePlacement(board, candidates[base + position - 1], cost, searchMode) < 0
      ) {
        candidates[base + position] = candidates[base + position - 1];
        position--;
      }
      candidates[base + position] = board;
      candidateCount++;
    }
    for (let index = 0; index < candidateCount; index++) {
      const board = candidates[base + index];
      const opening = uses[board] === 0;
      assignment[depth] = board;
      remaining[board] -= cost;
      uses[board]++;
      search(depth + 1, usedStock + (opening ? lengths[board] : 0), usedBoards + (opening ? 1 : 0));
      uses[board]--;
      remaining[board] += cost;
      assignment[depth] = -1;
      if (stoppedAtLimit) break;
    }
  }

  search(0, 0, 0);
  const bounded = stoppedAtLimit || nodes >= LIMITS.searchNodes;
  const chosen = hasComplete ? bestComplete : bestPartial;
  const layouts: BoardLayout[] = [];
  const producedQuantities = new Uint8Array(workspace.requirements.length);
  for (let board = 0; board < boardCount; board++) {
    const cuts: BoardLayout['cuts'] = [];
    let offsetMm = 0;
    for (let index = 0; index < partCount; index++) {
      if (chosen[index] !== board) continue;
      const part = parts[index];
      const requirement = workspace.requirements[part.requirementIndex];
      cuts.push({
        requirementId: requirement.id,
        label: requirement.label,
        instance: part.instance,
        lengthMm: requirement.lengthMm,
        offsetMm,
      });
      producedQuantities[part.requirementIndex]++;
      // One saw pass per part, including the final part; no free factory-end cut.
      offsetMm += part.consumedMm;
    }
    if (cuts.length === 0) continue;
    const remnantMm = lengths[board] - offsetMm;
    layouts.push({
      stockId: boards[board].id,
      stockLabel: boards[board].label,
      stockKind: boards[board].kind,
      stockLengthMm: lengths[board],
      cuts,
      kerfMm: cuts.length * kerf,
      remnantMm,
      remnantKind: remnantMm === 0 ? 'none' : remnantMm >= reusableThreshold ? 'reusable' : 'scrap',
    });
  }

  // Derive accounting from the actual returned layouts, including partial plans.
  const metrics: PlanSolution['metrics'] = {
    stockUsedMm: 0,
    partsMm: 0,
    kerfMm: 0,
    reusableMm: 0,
    scrapMm: 0,
    boardCount: layouts.length,
    utilization: 0,
  };
  for (const layout of layouts) {
    metrics.stockUsedMm += layout.stockLengthMm;
    metrics.kerfMm += layout.kerfMm;
    for (const cut of layout.cuts) metrics.partsMm += cut.lengthMm;
    if (layout.remnantKind === 'reusable') metrics.reusableMm += layout.remnantMm;
    if (layout.remnantKind === 'scrap') metrics.scrapMm += layout.remnantMm;
  }
  if (metrics.stockUsedMm !== 0) metrics.utilization = metrics.partsMm / metrics.stockUsedMm;

  const unfulfilled: PlanSolution['unfulfilled'] = [];
  const longestStockMm = boardCount === 0 ? 0 : lengths[boardCount - 1];
  for (let index = 0; index < workspace.requirements.length; index++) {
    const requirement = workspace.requirements[index];
    const quantity = requirement.quantity - producedQuantities[index];
    if (quantity === 0) continue;
    let reason: string;
    if (boardCount === 0) {
      reason = 'No unlocked, non-excluded stock is available.';
    } else if (requirement.lengthMm + kerf > longestStockMm) {
      reason = `Each part needs ${requirement.lengthMm + kerf} mm including kerf; the longest eligible board is ${longestStockMm} mm.`;
    } else if (totalDemandMm > eligibleStockMm) {
      reason = `The complete job needs ${totalDemandMm} mm including kerf, but eligible stock totals ${eligibleStockMm} mm. This quantity remains unplanned.`;
    } else if (bounded) {
      reason = `No complete arrangement was found within the ${LIMITS.searchNodes}-node bound. This quantity remains unplanned; infeasibility is not proven.`;
    } else {
      reason =
        'The full search found no arrangement fulfilling every requirement on eligible stock. This quantity remains unplanned.';
    }
    unfulfilled.push({ requirementId: requirement.id, label: requirement.label, quantity, reason });
  }
  const complete = unfulfilled.length === 0;
  return {
    objective,
    layouts,
    metrics,
    complete,
    unfulfilled,
    excludedStockIds: canonicalExclusions,
    search: {
      method: 'branch-and-bound',
      provenOptimal: complete && !bounded,
      nodes,
      limit: LIMITS.searchNodes,
    },
  };
}
