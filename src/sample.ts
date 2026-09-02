import type { Workspace } from './types';

/** Original, illustrative measurements, not a real customer's workshop. */
export function createSampleWorkspace(revision = 0): Workspace {
  return {
    revision,
    title: 'The little library',
    material: 'Pine · 18 × 140 mm · usable lengths',
    stock: [
      { id: 'A-01', label: 'Long board', lengthMm: 3000, kind: 'board', locked: false },
      { id: 'A-02', label: 'Fresh board 02', lengthMm: 2400, kind: 'board', locked: false },
      { id: 'A-03', label: 'Fresh board 03', lengthMm: 2400, kind: 'board', locked: false },
      { id: 'A-04', label: 'Fresh board 04', lengthMm: 2400, kind: 'board', locked: false },
      { id: 'R-01', label: 'Bench project offcut', lengthMm: 1180, kind: 'offcut', locked: false },
      { id: 'R-02', label: 'Saved shelf offcut', lengthMm: 960, kind: 'offcut', locked: false },
      { id: 'R-03', label: 'Window seat offcut', lengthMm: 740, kind: 'offcut', locked: false },
      {
        id: 'R-04',
        label: 'The useful little piece',
        lengthMm: 650,
        kind: 'offcut',
        locked: false,
      },
    ],
    requirements: [
      { id: 'shelf', label: 'Shelves', lengthMm: 720, quantity: 4 },
      { id: 'upright', label: 'Uprights', lengthMm: 440, quantity: 4 },
      { id: 'rail', label: 'Rails', lengthMm: 310, quantity: 4 },
      { id: 'brace', label: 'Braces', lengthMm: 560, quantity: 2 },
    ],
    settings: { kerfMm: 3, minReusableMm: 400 },
  };
}

export function createEmptyWorkspace(revision = 0): Workspace {
  return {
    revision,
    title: 'My next project',
    material: 'Same material and cross-section · usable lengths',
    stock: [],
    requirements: [],
    settings: { kerfMm: 3, minReusableMm: 400 },
  };
}
