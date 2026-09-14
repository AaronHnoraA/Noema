export function captureTokenFile(stateRoot: string): string;
export function ensureCaptureToken(stateRoot: string): Promise<string>;
export function captureRequestAuthorized(header: unknown, token: string): boolean;
