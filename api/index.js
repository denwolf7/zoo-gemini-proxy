export const config = {
  runtime: 'edge',
};

function cleanSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);

  const newObj = {};
  for (const [key, val] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    newObj[key] = cleanSchema(val);
  }
  return newObj;
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname.includes("/models")) {
    const models = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.5-flash"];
    return new Response(
      JSON.stringify({
        object: "list",
        data: models.map(id => ({ id, object: "model" }))
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  let apiKey = "";
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    apiKey = authHeader.replace("Bearer ", "").trim();
  } else {
    apiKey = request.headers.get("x-goog-api-key") || "";
  }

  if (request.method === "POST") {
    try {
      const body = await request.json();
      let model = (body.model || "gemini-3.5-flash").replace(/^models\//, "");
      const isStream = Boolean(body.stream);

      const contents = [];
      let systemInstructionText = "";

      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (m.role === "system") {
            systemInstructionText += (systemInstructionText ? "\n\n" : "") + (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
          } else if (m.role === "assistant") {
            const parts = [];
            if (m.content) parts.push({ text: m.content });
            if (Array.isArray(m.tool_calls)) {
              for (const tc of m.tool_calls) {
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch (e) {}
                parts.push({
                  functionCall: {
                    name: tc.function.name,
                    args: args
                  }
                });
              }
            }
            if (parts.length > 0) contents.push({ role: "model", parts });
          } else if (m.role === "tool") {
            let responseContent = {};
            try {
              responseContent = JSON.parse(m.content);
            } catch (e) {
              responseContent = { result: m.content };
            }
            contents.push({
              role: "user",
              parts: [{
                functionResponse: {
                  name: m.name || "tool_response",
                  response: responseContent
                }
              }]
            });
          } else {
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            contents.push({ role: "user", parts: [{ text }] });
          }
        }
      }

      if (contents.length === 0) {
        contents.push({ role: "user", parts: [{ text: "hi" }] });
      }

      const geminiPayload = { contents };
      if (systemInstructionText) {
        geminiPayload.systemInstruction = {
          parts: [{ text: systemInstructionText }]
        };
      }

      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const functionDeclarations = [];
        for (const t of body.tools) {
          if (t.type === "function" && t.function) {
            functionDeclarations.push({
              name: t.function.name,
              description: t.function.description || "",
              parameters: cleanSchema(t.function.parameters) || { type: "OBJECT", properties: {} }
            });
          }
        }
        if (functionDeclarations.length > 0) {
          geminiPayload.tools = [{ functionDeclarations }];
        }
      }

      const endpoint = isStream ? "streamGenerateContent?alt=sse&key=" : "generateContent?key=";
      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}${apiKey}`;

      const gResponse = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload),
      });

      if (!gResponse.ok) {
        const errText = await gResponse.text();
        return new Response(errText, {
          status: gResponse.status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // Режим STREAMING (защита от 504 Gateway Timeout)
      if (isStream) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
          const reader = gResponse.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  const dataStr = line.replace(/^data: /, "").trim();
                  if (!dataStr) continue;

                  try {
                    const parsed = JSON.parse(dataStr);
                    const candidate = parsed.candidates?.[0]?.content;
                    let delta = {};

                    if (candidate?.parts) {
                      for (const part of candidate.parts) {
                        if (part.text) {
                          delta.content = (delta.content || "") + part.text;
                        }
                        if (part.functionCall) {
                          delta.tool_calls = delta.tool_calls || [];
                          delta.tool_calls.push({
                            index: 0,
                            id: "call_" + Math.random().toString(36).substring(2, 11),
                            type: "function",
                            function: {
                              name: part.functionCall.name,
                              arguments: JSON.stringify(part.functionCall.args || {})
                            }
                          });
                        }
                      }
                    }

                    const chunk = {
                      id: "chatcmpl-" + Date.now(),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [{ index: 0, delta: delta, finish_reason: null }]
                    };

                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  } catch (e) {}
                }
              }
            }

            const endChunk = {
              id: "chatcmpl-" + Date.now(),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\ndata: [DONE]\n\n`));
          } catch (err) {
          } finally {
            await writer.close();
          }
        })();

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // Непотоковый режим (для коротких запросов)
      const gData = await gResponse.json();
      const candidate = gData.candidates?.[0]?.content;
      let assistantContent = null;
      const toolCalls = [];

      if (candidate?.parts) {
        for (let i = 0; i < candidate.parts.length; i++) {
          const part = candidate.parts[i];
          if (part.text) {
            assistantContent = (assistantContent || "") + part.text;
          }
          if (part.functionCall) {
            toolCalls.push({
              id: "call_" + Math.random().toString(36).substring(2, 11),
              type: "function",
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
              }
            });
          }
        }
      }

      const messageObj = { role: "assistant", content: assistantContent };
      if (toolCalls.length > 0) messageObj.tool_calls = toolCalls;

      const openAiResponse = {
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            message: messageObj,
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: gData.usageMetadata?.promptTokenCount || 0,
          completion_tokens: gData.usageMetadata?.candidatesTokenCount || 0,
          total_tokens: gData.usageMetadata?.totalTokenCount || 0,
        },
      };

      return new Response(JSON.stringify(openAiResponse), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  }

  return new Response("OK", { status: 200 });
}
