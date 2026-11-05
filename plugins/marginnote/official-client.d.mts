export interface OfficialConnection { url: string; token: string; device: "mac" | "ipad" }
export function validateOfficialConnection(config: {url: string; token: string}, device: string): OfficialConnection;
export function officialConnection(device?: string): Promise<OfficialConnection>;
export function createOfficialClient(config: OfficialConnection, options?: { fetchImpl?: typeof fetch; pause?: (ms: number) => Promise<void> }): {
  call(path: string, body?: Record<string, any>): Promise<Record<string, any>>;
  status(): Promise<Record<string, any>>;
  open(): Promise<Record<string, any>>;
};
export function callOfficial(path: string, body?: Record<string, unknown>, options?: {device?: string}): Promise<Record<string, any>>;
