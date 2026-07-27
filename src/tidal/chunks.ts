export const MAX_MUTATION_ITEMS = 50;

export function chunkItems<T>(
  items: readonly T[],
  size = MAX_MUTATION_ITEMS,
): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
