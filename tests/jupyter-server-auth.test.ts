import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import http from "node:http";
import { createHttpClient } from "../server/jupyter/http-client.mjs";
import { connectToServer, normalizeBaseUrl, websocketUrlFor } from "../server/jupyter/server-auth.mjs";

// Auth against a stub that behaves the way a real Jupyter server does: it
// issues an _xsrf cookie, refuses unsafe requests that do not echo it, and
// redirects on a successful login. These are the parts that are easy to get
// subtly wrong and impossible to notice until a real deployment rejects you.

type Route = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function withServer(routes: Record<string, Route>, run: (base: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url || "/", "http://localhost").pathname;
      const route = routes[path];
      if (!route) {
        res.writeHead(404).end("not found");
        return;
      }
      route(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("normalizeBaseUrl", () => {
  test("strips the app path and lifts a token out of the query", () => {
    // Exactly what `jupyter lab` prints on startup.
    expect(normalizeBaseUrl("http://localhost:8888/lab?token=abc123")).toEqual({
      baseUrl: "http://localhost:8888/",
      token: "abc123",
    });
  });

  test("keeps a base path prefix, as JupyterHub user servers have", () => {
    expect(normalizeBaseUrl("https://hub.example.org/user/aaron/tree").baseUrl)
      .toBe("https://hub.example.org/user/aaron/");
  });

  test("adds the trailing slash @jupyterlab/services expects", () => {
    expect(normalizeBaseUrl("http://localhost:8888").baseUrl).toBe("http://localhost:8888/");
  });

  test("websocket url follows the scheme", () => {
    expect(websocketUrlFor("https://x.test/")).toBe("wss://x.test/");
    expect(websocketUrlFor("http://x.test/")).toBe("ws://x.test/");
  });
});

describe("http client", () => {
  test("persists cookies and echoes _xsrf on unsafe methods", async () => {
    const seen: Array<{ method: string; xsrf: string | undefined; cookie: string | undefined }> = [];
    await withServer({
      "/set": (_req, res) => {
        res.writeHead(200, { "Set-Cookie": "_xsrf=tok123; Path=/" }).end("ok");
      },
      "/post": (req, res) => {
        seen.push({
          method: req.method || "",
          xsrf: req.headers["x-xsrftoken"] as string | undefined,
          cookie: req.headers.cookie,
        });
        res.writeHead(200).end("ok");
      },
    }, async (base) => {
      const client = createHttpClient();
      await client.fetch(`${base}set`);
      expect(client.xsrf()).toBe("tok123");
      await client.fetch(`${base}post`, { method: "POST", body: "{}" });
      // A GET must not carry the XSRF header; a POST must.
      await client.fetch(`${base}post`, { method: "GET" });
    });
    expect(seen[0]).toMatchObject({ method: "POST", xsrf: "tok123", cookie: "_xsrf=tok123" });
    expect(seen[1].xsrf).toBeUndefined();
  });

  test("follows redirects and turns a redirected POST into a GET", async () => {
    const methods: string[] = [];
    await withServer({
      "/start": (req, res) => {
        methods.push(req.method || "");
        res.writeHead(302, { Location: "/end" }).end();
      },
      "/end": (req, res) => {
        methods.push(req.method || "");
        res.writeHead(200).end("done");
      },
    }, async (base) => {
      const client = createHttpClient();
      const response = await client.fetch(`${base}start`, { method: "POST", body: "x=1" });
      expect(await response.text()).toBe("done");
    });
    expect(methods).toEqual(["POST", "GET"]);
  });

  test("redirect: manual leaves the redirect to the caller", async () => {
    await withServer({
      "/start": (_req, res) => { res.writeHead(302, { Location: "/end" }).end(); },
    }, async (base) => {
      const client = createHttpClient();
      const response = await client.fetch(`${base}start`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/end");
    });
  });
});

describe("connectToServer", () => {
  test("token auth sends Authorization on every request", async () => {
    const auth: Array<string | undefined> = [];
    await withServer({
      "/api/status": (req, res) => {
        auth.push(req.headers.authorization);
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      },
    }, async (base) => {
      const { client, baseUrl } = await connectToServer({ url: base, auth: "token", token: "secret" });
      await client.fetch(`${baseUrl}api/status`);
    });
    expect(auth).toEqual(["token secret"]);
  });

  test("a token in the pasted URL is used without being configured separately", async () => {
    const auth: Array<string | undefined> = [];
    await withServer({
      "/api/status": (req, res) => {
        auth.push(req.headers.authorization);
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      },
    }, async (base) => {
      const { client, baseUrl } = await connectToServer({ url: `${base}lab?token=frominurl`, auth: "token" });
      await client.fetch(`${baseUrl}api/status`);
    });
    expect(auth).toEqual(["token frominurl"]);
  });

  test("password login posts the _xsrf it was issued and keeps the session", async () => {
    let posted: Record<string, string> = {};
    await withServer({
      "/login": (req, res, body) => {
        if (req.method === "GET") {
          res.writeHead(200, { "Set-Cookie": "_xsrf=xy; Path=/", "Content-Type": "text/html" })
            .end('<input name="_xsrf" value="xy"><input name="password" type="password">');
          return;
        }
        posted = Object.fromEntries(new URLSearchParams(body));
        res.writeHead(302, { Location: "/tree", "Set-Cookie": "username-token=session; Path=/" }).end();
      },
    }, async (base) => {
      const { client } = await connectToServer({ url: base, auth: "password", password: "hunter2" });
      expect(client.cookieHeader()).toContain("username-token=session");
    });
    expect(posted).toEqual({ _xsrf: "xy", password: "hunter2" });
  });

  test("a wrong password is reported instead of silently half-connecting", async () => {
    await withServer({
      "/login": (req, res) => {
        if (req.method === "GET") {
          res.writeHead(200, { "Set-Cookie": "_xsrf=xy; Path=/", "Content-Type": "text/html" }).end("<html></html>");
          return;
        }
        // A real server re-renders the form on a bad password.
        res.writeHead(200, { "Content-Type": "text/html" })
          .end('<input name="password" type="password"><p>Invalid password</p>');
      },
    }, async (base) => {
      await expect(connectToServer({ url: base, auth: "password", password: "wrong" }))
        .rejects.toThrow(/incorrect password/i);
    });
  });

  test("password auth without a password fails fast", async () => {
    await expect(connectToServer({ url: "http://127.0.0.1:1/", auth: "password" }))
      .rejects.toThrow(/no password/i);
  });

  test("hub auth spawns the user server and returns its base url", async () => {
    let spawned = false;
    let polls = 0;
    await withServer({
      "/hub/api/users/aaron": (_req, res) => {
        polls += 1;
        // Not ready until the spawn has been asked for — the real idle-culled case.
        const servers = spawned && polls > 1 ? { "": { ready: true, url: "/user/aaron/" } } : {};
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: "aaron", servers }));
      },
      "/hub/api/users/aaron/server": (_req, res) => {
        spawned = true;
        res.writeHead(202).end();
      },
    }, async (base) => {
      const { baseUrl } = await connectToServer({
        url: base, auth: "hub", token: "hubtoken", user: "aaron",
      });
      expect(baseUrl).toBe(`${base}user/aaron/`);
      expect(spawned).toBe(true);
    });
  });
});
