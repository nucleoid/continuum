export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export interface NamedExtension {
  readonly id: string;
}

export class ExtensionRegistry<T extends NamedExtension> {
  private readonly extensions = new Map<string, T>();

  register(extension: T): void {
    if (!EXTENSION_ID_PATTERN.test(extension.id)) {
      throw new Error(`invalid extension id: ${extension.id}`);
    }
    if (this.extensions.has(extension.id)) {
      throw new Error(`duplicate extension id: ${extension.id}`);
    }
    this.extensions.set(extension.id, extension);
  }

  get(id: string): T | undefined {
    return this.extensions.get(id);
  }

  ids(): string[] {
    return [...this.extensions.keys()].sort();
  }

  all(): T[] {
    return this.ids().map((id) => this.extensions.get(id)!);
  }
}
