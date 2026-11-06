import { fileURLToPath } from 'node:url';

/**
 * A 512 m world ("testworld", map key "testmap", 2 × 2 tiles) made by the reference converter from a synthetic
 * export: flat ground at 100 m west of X = 300, a 10 % slope east of it, a road at Z 100–104, a pond, sea north of
 * Z = 480; two barracks (one turned by 90°), a 120 m power line whose box reaches into the next tile, a wall of an
 * unknown mod and a tree without class data. The class data hold Land_Mil_Barracks2 (with its raster), WoodenCrate and
 * the power line.
 */
export const FIXTURE = fileURLToPath(new URL('../fixtures/world-data/', import.meta.url));
