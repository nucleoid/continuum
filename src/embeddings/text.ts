export function memoryEmbeddingText(memory: { title: string; body: string }): string {
  return `${memory.title}\n\n${memory.body}`;
}
