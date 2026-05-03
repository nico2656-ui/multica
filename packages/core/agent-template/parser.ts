import type { CreateAgentRequest, AgentVisibility } from "../types/agent";

export interface ParsedTemplate {
  createRequest: CreateAgentRequest;
  skillNames: string[];
}

const VALID_VISIBILITIES: AgentVisibility[] = ["workspace", "private"];

/** Parse a Claude-compatible agent .md template into a Multica CreateAgentRequest. */
export function parseAgentMarkdown(md: string): ParsedTemplate {
  const frontmatter = extractFrontmatter(md);
  const body = extractBody(md);

  const skillNames = frontmatter.skills
    ? frontmatter.skills.split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];

  const visibilityRaw = frontmatter.visibility;
  const visibility: AgentVisibility | undefined =
    visibilityRaw && VALID_VISIBILITIES.includes(visibilityRaw as AgentVisibility)
      ? (visibilityRaw as AgentVisibility)
      : undefined;

  const createRequest: CreateAgentRequest = {
    name: frontmatter.name ?? "Imported Agent",
    description: frontmatter.description ?? "",
    instructions: body.trim(),
    runtime_id: "",
    model: frontmatter.model,
    visibility,
    max_concurrent_tasks: (() => {
      const raw = Number(frontmatter.max_concurrent_tasks);
      return Number.isFinite(raw) ? raw : undefined;
    })(),
  };

  return { createRequest, skillNames };
}

function extractFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatterStr = match[1] ?? "";
  const result: Record<string, string> = {};
  for (const line of frontmatterStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

function extractBody(md: string): string {
  const parts = md.split("---\n");
  if (parts.length >= 3) {
    return parts.slice(2).join("---\n").trim();
  }
  return md.trim();
}
