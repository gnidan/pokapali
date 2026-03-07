export interface PinnerConfig {
  appIds: string[];
  rateLimits?: {
    maxPerHour?: number;
    maxSizeBytes?: number;
  };
  storagePath: string;
  maxConnections?: number;
}

export function createPinner(
  config: PinnerConfig
): Promise<{
  start(): Promise<void>;
  stop(): Promise<void>;
}> {
  throw new Error("not implemented");
}
