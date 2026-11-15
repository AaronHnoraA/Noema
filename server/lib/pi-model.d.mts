export const DEFAULT_PI_MODEL: string;
export function piAgentDir(): string;
export function piPackage(): string;
export function createPiModel(options?: { modelId?: string; agentDir?: string }): Promise<{ modelId: string; complete(context: any, options: any): Promise<any> }>;
export function callOneTool(request: { system: string; user: string; tool: { name: string; description: string; parameters: any }; timeoutMs?: number }): Promise<any>;
