export const providerDocs: Readonly<Record<'meta' | 'x' | 'linkedin', string>>;

export function startLoopbackProbe(options: {
  state: string;
  timeoutMs?: number;
}): Promise<{
  redirectUri: string;
  result: Promise<{ code: string }>;
  close(): Promise<void>;
}>;
