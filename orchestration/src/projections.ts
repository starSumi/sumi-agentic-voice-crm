import { stringify as stringifyToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";
import type { OrchestrationRole, OrchestrationSpec } from "./types.ts";

const GENERATED_HEADER =
  "# Generated from orchestration/orchestration.yaml. Do not edit.\n";

function renderCodexConfig(spec: OrchestrationSpec): string {
  return `${GENERATED_HEADER}${stringifyToml({
    agents: {
      enabled: true,
      max_concurrent_threads_per_session: spec.scheduler.max_concurrency,
      interrupt_message: true,
    },
  })}`;
}

function renderAgent(role: OrchestrationRole): string {
  return `${GENERATED_HEADER}${stringifyToml({
    name: role.id,
    description: role.description,
    sandbox_mode: role.sandbox_mode,
    developer_instructions: role.developer_instructions.trim(),
  })}`;
}

function renderSkillMetadata(): string {
  return stringifyYaml({
    interface: {
      display_name: "Sumi Orchestration",
      short_description:
        "Compile and verify bounded Sumi engineering workflows",
      default_prompt:
        "Compile this work into bounded task packets, schedule only dependency-ready non-conflicting tasks, and bind completion to evidence.",
    },
    policy: { allow_implicit_invocation: true },
  });
}

export function orchestrationProjectionFiles(
  spec: OrchestrationSpec,
): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  files.set(spec.projections.codex.config, renderCodexConfig(spec));
  for (const role of spec.roles.filter(
    (candidate) => candidate.projection === "custom",
  )) {
    files.set(
      `${spec.projections.codex.agents_directory}/${role.id}.toml`,
      renderAgent(role),
    );
  }
  files.set(spec.projections.skill.metadata, renderSkillMetadata());
  return files;
}
