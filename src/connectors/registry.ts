import { repositoryEvidenceClasses, type RepositoryEvidenceConnector } from './evidence.js';

/** Trusted composition only. Never populated from reference data or wire fields. */
export class RepositoryEvidenceRegistry {
  private readonly connectors = new Map<string, RepositoryEvidenceConnector>();
  register(connector: RepositoryEvidenceConnector): void {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(connector.id) || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(connector.version)
      || this.connectors.has(connector.id) || !Array.isArray(connector.classes) || connector.classes.length < 1
      || new Set(connector.classes).size !== connector.classes.length
      || connector.classes.some(c => !repositoryEvidenceClasses.includes(c)) || typeof connector.open !== 'function') {
      throw new TypeError('Invalid or duplicate repository evidence connector');
    }
    this.connectors.set(connector.id, Object.freeze({ id: connector.id, version: connector.version,
      classes: Object.freeze([...connector.classes]), open: connector.open.bind(connector) }));
  }
  ids(): string[] { return [...this.connectors.keys()].sort(); }
  get(id: string): RepositoryEvidenceConnector | undefined { return this.connectors.get(id); }
}
