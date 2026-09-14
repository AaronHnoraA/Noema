const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const workstream = document.querySelector("#workstream");
const status = document.querySelector("#status");

async function restore() {
  const stored = await chrome.storage.local.get({ endpoint: "", token: "", workstreamId: "" });
  endpoint.value = stored.endpoint;
  token.value = stored.token;
  workstream.value = stored.workstreamId;
}

document.querySelector("#save").addEventListener("click", async () => {
  try {
    const parsed = new URL(endpoint.value.trim());
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) throw new Error("Use http://127.0.0.1:<port>");
    if (!token.value.trim()) throw new Error("Capture token is required");
    await chrome.storage.local.set({
      endpoint: parsed.origin,
      token: token.value.trim(),
      workstreamId: workstream.value.trim(),
    });
    status.textContent = "Saved";
  } catch (error) {
    status.textContent = error.message;
  }
});

restore();
