import type { Agent } from "../types/agent";

export interface AgentTemplate {
  name: string;
  description: string;
  model: string;
  instructions: string;
  runtime: string;
  skills: string[];
  visibility: string;
  max_concurrent_tasks: number;
}

function yamlSafe(v: string): string {
  if (/[:#\{\}\[\],&*?|>='"!%@`\n\r]/.test(v)) return JSON.stringify(v);
  return v;
}

/** Convert a Multica Agent to a Claude-compatible Markdown template. */
export function exportAgentToMarkdown(agent: Agent): string {
  const skills = agent.skills?.map((s) => s.name) ?? [];

  const yaml = [
    `name: ${yamlSafe(agent.name)}`,
    `description: ${yamlSafe(agent.description ?? "")}`,
    agent.model ? `model: ${agent.model}` : null,
    skills.length > 0 ? `skills: ${skills.join(", ")}` : null,
    `runtime: ${agent.runtime_mode ?? "local"}`,
    `visibility: ${agent.visibility ?? "workspace"}`,
    `max_concurrent_tasks: ${agent.max_concurrent_tasks ?? 1}`,
  ]
    .filter(Boolean)
    .join("\n");

  return ["---", yaml, "---", "", agent.instructions ?? ""].join("\n");
}
