#!/usr/bin/env node
/**
 * codex-9router-wrapper.js: A smart bridge that uses 9Router (OpenAI-compatible)
 * and supports LOCAL tool execution (bash, search, email, Paperclip mutations).
 */
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);

// Only intercept `exec` subcommand (Paperclip's usage)
if (args[0] !== "exec") {
  process.stderr.write(`[codex-wrapper] unsupported command: ${args.join(" ")}\n`);
  process.exit(1);
}

const modelIdx = args.indexOf("--model");
const model = modelIdx !== -1 ? args[modelIdx + 1] : (process.env.OPENAI_MODEL || "gpt-5.4");
const apiKey = process.env.OPENAI_API_KEY || "sk-dummy";
const rawBase = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a shell command and return stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "brave_search",
      description: "Search the web using Brave Search API.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "resend_email",
      description: "Send an email via Resend API.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject." },
          html: { type: "string", description: "Email body in HTML format." }
        },
        required: ["to", "subject", "html"]
      }
    }
  },
  // --- Paperclip Specific Tools ---
  {
    type: "function",
    function: {
      name: "paperclip_list_agents",
      description: "List all agents in the current company.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "paperclip_hire_agent",
      description: "Hire a new agent in the current company.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the agent." },
          role: { type: "string", description: "Role (e.g., cto, dev, qa)." },
          adapterType: { type: "string", description: "Adapter type (e.g., codex_local)." },
          adapterConfig: { type: "object", description: "Optional adapter configuration overrides." }
        },
        required: ["name", "role", "adapterType"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "paperclip_list_issues",
      description: "List issues in the current company.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status (e.g., backlog, in_progress, done)." },
          assigneeAgentId: { type: "string", description: "Filter by assignee agent ID." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "paperclip_create_issue",
      description: "Create a new issue/task in Paperclip.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title of the issue." },
          description: { type: "string", description: "Detailed description." },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], default: "medium" },
          assigneeAgentId: { type: "string", description: "Optional: ID of the agent to assign to." },
          projectId: { type: "string", description: "Optional: Project ID." }
        },
        required: ["title", "description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "paperclip_update_issue",
      description: "Update an existing issue's status or details.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The ID or identifier (e.g., ALA-3) of the issue." },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "done", "cancelled"] },
          assigneeAgentId: { type: "string", description: "ID of the agent to assign to." },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] }
        },
        required: ["issueId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "paperclip_add_comment",
      description: "Add a comment to an issue.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The ID or identifier of the issue." },
          body: { type: "string", description: "Comment body (Markdown supported)." }
        },
        required: ["issueId", "body"]
      }
    }
  }
];

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

async function request(url, options, body) {
  const endpoint = new URL(url);
  const transport = endpoint.protocol === "https:" ? https : http;
  
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
      path: endpoint.pathname + (endpoint.search || ""),
      method: options.method || "POST",
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on("error", (e) => reject(e));
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function executeTool(name, args) {
  process.stderr.write(`[bridge] executing tool: ${name} with ${JSON.stringify(args)}\n`);
  
  // 1. Basic Tools
  if (name === "bash") {
    try {
      const output = execSync(args.command, { encoding: "utf8", timeout: 30000 });
      return output;
    } catch (e) {
      return `Error: ${e.message}\nStdout: ${e.stdout}\nStderr: ${e.stderr}`;
    }
  }
  if (name === "brave_search") {
    const braveKey = process.env.brave_api_key;
    if (!braveKey) return "Error: brave_api_key not found in environment.";
    try {
      const resp = await request(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}`, {
        method: "GET",
        headers: { "X-Subscription-Token": braveKey }
      });
      return resp;
    } catch (e) {
      return `Brave Error: ${e.message}`;
    }
  }
  if (name === "resend_email") {
    const resendKey = process.env.resend_api_key;
    if (!resendKey) return "Error: resend_api_key not found in environment.";
    try {
      const resp = await request(`https://api.resend.com/emails`, {
        headers: { "Authorization": `Bearer ${resendKey}` }
      }, {
        from: "Paperclip <onboarding@resend.dev>",
        to: [args.to],
        subject: args.subject,
        html: args.html
      });
      return resp;
    } catch (e) {
      return `Resend Error: ${e.message}`;
    }
  }

  // 2. Paperclip Tools
  const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
  const apiToken = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;

  if (!apiToken || !companyId) {
    return "Error: Paperclip API credentials missing in environment.";
  }

  const apiHeaders = { "Authorization": `Bearer ${apiToken}` };

  try {
    // Sanitize common UUID/optional fields: convert empty string to null or omit
    const sanitize = (obj) => {
      const result = { ...obj };
      for (const key in result) {
        if (result[key] === "") result[key] = null;
      }
      return result;
    };

    if (name === "paperclip_list_agents") {
      return await request(`${apiBase}/api/companies/${companyId}/agents`, { method: "GET", headers: apiHeaders });
    }
    if (name === "paperclip_hire_agent") {
      return await request(`${apiBase}/api/companies/${companyId}/agent-hires`, { headers: apiHeaders }, sanitize(args));
    }
    if (name === "paperclip_update_agent") {
      const { agentId, ...rest } = args;
      return await request(`${apiBase}/api/agents/${agentId}`, { method: "PATCH", headers: apiHeaders }, sanitize(rest));
    }
    if (name === "paperclip_list_issues") {
      const query = new URLSearchParams(args).toString();
      return await request(`${apiBase}/api/companies/${companyId}/issues?${query}`, { method: "GET", headers: apiHeaders });
    }
    if (name === "paperclip_create_issue") {
      return await request(`${apiBase}/api/companies/${companyId}/issues`, { headers: apiHeaders }, sanitize(args));
    }
    if (name === "paperclip_update_issue") {
      const { issueId, ...rest } = args;
      return await request(`${apiBase}/api/issues/${issueId}`, { method: "PATCH", headers: apiHeaders }, sanitize(rest));
    }
    if (name === "paperclip_add_comment") {
      const { issueId, body } = args;
      return await request(`${apiBase}/api/issues/${issueId}/comments`, { headers: apiHeaders }, { body });
    }
  } catch (e) {
    return `Paperclip API Error: ${e.message}`;
  }

  return `Error: Unknown tool ${name}`;
}

async function run() {
  const prompt = await readStdin();
  
  if (!prompt.trim()) {
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }) + "\n");
    process.exit(0);
  }

  const messages = [
    { role: "system", content: "You are a Paperclip agent. Use the provided tools to complete your task. When creating agents or issues, always ensure you have the correct companyId and required fields." },
    { role: "user", content: prompt }
  ];

  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "local-thread-1" }) + "\n");

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

  try {
    for (let i = 0; i < 15; i++) { // Max turns
      const body = {
        model,
        messages,
        tools: TOOLS,
        tool_choice: "auto"
      };

      const respText = await request(`${rawBase}/chat/completions`, {
        headers: { "Authorization": `Bearer ${apiKey}` }
      }, body);

      const json = JSON.parse(respText);
      const message = json.choices[0].message;
      messages.push(message);

      totalUsage.prompt_tokens += json.usage?.prompt_tokens || 0;
      totalUsage.completion_tokens += json.usage?.completion_tokens || 0;

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const result = await executeTool(toolCall.function.name, JSON.parse(toolCall.function.arguments));
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: String(result)
          });
        }
        continue;
      }

      // Final response
      const content = message.content || "";
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: content } }) + "\n");
      process.stdout.write(JSON.stringify({
        type: "turn.completed",
        summary: content.slice(0, 200),
        usage: {
          input_tokens: totalUsage.prompt_tokens,
          output_tokens: totalUsage.completion_tokens
        }
      }) + "\n");
      process.exit(0);
    }
  } catch (e) {
    process.stderr.write(`[bridge] error: ${e.stack || e}\n`);
    process.exit(1);
  }
}

run();
