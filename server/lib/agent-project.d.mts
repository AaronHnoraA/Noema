export function agentProjectStatus(body: any, deps: { call: (channel: string, args?: any[]) => Promise<any> }): Promise<any>;
export function agentProjectMaintain(body: any, deps: { call: (channel: string, args?: any[]) => Promise<any> }): Promise<any>;
export function agentMemorySearch(body: any, deps?: { search?: (root: string, query: string) => Promise<any> }): Promise<any>;
