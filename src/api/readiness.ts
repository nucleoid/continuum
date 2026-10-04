export interface ReadinessState {
  isReady(): boolean;
  markUnready(): void;
}

export function createReadinessState(): ReadinessState {
  let ready = true;
  return {
    isReady: () => ready,
    markUnready: () => { ready = false; },
  };
}
