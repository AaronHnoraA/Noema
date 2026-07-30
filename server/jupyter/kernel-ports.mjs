// Port allocation for raw ZMQ kernel connections.
// Ported concept from microsoft/vscode-jupyter (MIT) src/kernels/common/usedPorts.ts
// + kernelLauncher.node.ts's findNextFreePort, using Node's own `net` module
// instead of the `portfinder` package (avoids an extra dependency for a
// four-line "listen on :0, read the port, close" trick).

import net from "node:net";

const usedPorts = new Set();

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Allocate `count` distinct free TCP ports, tracked process-wide so concurrent kernel launches don't collide. */
export async function allocateKernelPorts(count = 5) {
  const ports = [];
  // Ports can only be reserved by re-binding is not possible between the
  // free-port probe and the kernel actually binding it; tracking in
  // `usedPorts` at least prevents *us* from handing the same port to two
  // kernels launched back-to-back before either binds.
  while (ports.length < count) {
    const port = await findFreePort();
    if (usedPorts.has(port) || ports.includes(port)) continue;
    ports.push(port);
  }
  for (const port of ports) usedPorts.add(port);
  return ports;
}

export function releaseKernelPorts(ports) {
  for (const port of ports) usedPorts.delete(port);
}
