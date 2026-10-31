// One API key and what its holder may use. Limits are optional; the server-wide caps always apply too.
export interface ApiKey {
  name: string;
  key: string;
  maxSandboxes?: number;
  maxMemoryMb?: number;
}

// The owner recorded on sandboxes created without any API key configured.
export const LOCAL_OWNER = "local";
