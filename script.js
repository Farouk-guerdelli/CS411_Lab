// Simple client for talking to your VM's HTTP server.
// The server URL is stored in localStorage so it persists across page loads.

const serverUrlInput = document.getElementById("serverUrl");
const saveUrlBtn = document.getElementById("saveUrlBtn");
const endpointInput = document.getElementById("endpoint");
const methodSelect = document.getElementById("method");
const bodyInput = document.getElementById("body");
const sendBtn = document.getElementById("sendBtn");
const output = document.getElementById("output");

const STORAGE_KEY = "net-client-server-url";

function loadServerUrl() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) serverUrlInput.value = saved;
}

function saveServerUrl() {
  localStorage.setItem(STORAGE_KEY, serverUrlInput.value.trim());
  output.textContent = "Server URL saved: " + serverUrlInput.value.trim();
}

async function sendRequest() {
  const base = serverUrlInput.value.trim().replace(/\/$/, "");
  const endpoint = endpointInput.value.trim();
  const method = methodSelect.value;

  if (!base) {
    output.textContent = "Set a server URL first (e.g. http://192.168.1.10:8000).";
    return;
  }

  const url = base + endpoint;
  const options = { method };

  if (method === "POST" && bodyInput.value.trim()) {
    try {
      JSON.parse(bodyInput.value); // validate
      options.headers = { "Content-Type": "application/json" };
      options.body = bodyInput.value;
    } catch (e) {
      output.textContent = "Invalid JSON in body: " + e.message;
      return;
    }
  }

  output.textContent = "Sending " + method + " " + url + " ...";

  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? JSON.stringify(await res.json(), null, 2)
      : await res.text();

    output.textContent = `Status: ${res.status} ${res.statusText}\n\n${data}`;
  } catch (err) {
    output.textContent =
      "Request failed: " + err.message +
      "\n\nCheck that:\n" +
      "- the server is running on the VM\n" +
      "- the URL/port are correct\n" +
      "- the VM's firewall allows the port\n" +
      "- CORS is enabled on the server if it's a different origin";
  }
}

saveUrlBtn.addEventListener("click", saveServerUrl);
sendBtn.addEventListener("click", sendRequest);
window.addEventListener("DOMContentLoaded", loadServerUrl);
