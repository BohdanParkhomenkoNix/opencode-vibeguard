import http from "node:http"

export const PLACEHOLDER = /__VG_[A-Z0-9_]+_[0-9a-f]{12}(?:_\d+)?__/g

let seq = 0

function sse(id, delta, finish = null, usage) {
  const chunk = {
    id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  if (usage) chunk.usage = usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export function toolNames(body) {
  return (body?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean)
}

export function toolArgs(body, name, values) {
  const tool = (body?.tools ?? []).find((t) => (t?.function?.name ?? t?.name) === name)
  const required = tool?.function?.parameters?.required ?? tool?.parameters?.required ?? []
  const args = { ...values }
  for (const key of required) if (!(key in args)) args[key] = "e2e"
  return args
}

export async function startMockProvider(respond) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }))
      }
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404)
        return res.end()
      }
      let body = null
      try { body = JSON.parse(raw) } catch {}
      requests.push({ path: req.url, body, raw })
      let reply
      try { reply = respond(body, requests) } catch (error) { reply = { text: `mock responder error: ${error.message}` } }
      const usage = reply.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      const id = `chatcmpl-${++seq}`
      const call = reply.tool && { id: `call_${seq}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }
      if (!body?.stream) {
        const message = call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: reply.text }
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({
          id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock",
          choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }], usage,
        }))
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      if (call) {
        res.write(sse(id, { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }))
        res.write(sse(id, { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] }))
        res.write(sse(id, {}, "tool_calls", usage))
      } else {
        res.write(sse(id, { role: "assistant", content: reply.text }))
        res.write(sse(id, {}, "stop", usage))
      }
      res.end("data: [DONE]\n\n")
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
