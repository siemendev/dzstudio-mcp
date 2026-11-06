/**
 * The types every participant of a session registers, in exactly these versions. A participant without the game
 * knows the same list as a dzStudio build, so that all of them accept and reject the same operations.
 */

export const TEXTFORM = 1;

export interface ElementType {
  version: number;
  parents: readonly string[];
}

export const ELEMENT_TYPES: ReadonlyMap<string, ElementType> = new Map([
  ['core:project', { version: 1, parents: [] }],
  ['core:group', { version: 1, parents: ['core:project'] }],
  ['core:object', { version: 1, parents: ['core:group'] }],
  ['loot:entry', { version: 1, parents: ['core:project'] }],
]);

export const OPERATION_TYPES: ReadonlyMap<string, number> = new Map([
  ['core:load', 1],
  ['core:undo', 1],
  ['core:redo', 1],
  ['core:revert', 1],
  ['projects:edit', 1],
  ['placement:edit', 1],
  ['properties:edit', 1],
  ['brush:edit', 1],
  ['spawner:edit', 1],
  ['loot:edit', 1],
]);

export const COMPANION_TYPES: ReadonlyMap<string, number> = new Map([
  ['projects:plugins', 1],
  ['projects:entry', 1],
  ['spawner:root', 1],
  ['spawner:read', 1],
  ['loot:setting', 1],
]);

export function pluginOf(type: string): string {
  const i = type.indexOf(':');
  return i < 0 ? type : type.slice(0, i);
}
