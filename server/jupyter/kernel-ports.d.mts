export function allocateKernelPorts(count?: number): Promise<number[]>;
export function releaseKernelPorts(ports: number[]): void;
