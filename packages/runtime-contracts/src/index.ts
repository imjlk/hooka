import type {
  CapabilityDefinition,
  CapabilityEnvContract,
} from "@hooka/task-sdk";

export interface CapabilityEnvRequirement
  extends Omit<CapabilityEnvContract, "secret"> {
  capabilityId: string;
  secret: boolean;
}

export interface MissingCapabilityEnvRequirement
  extends CapabilityEnvRequirement {
  missingNames: string[];
  presentNames: string[];
}

export function collectCapabilityEnvRequirements(
  capabilities: CapabilityDefinition[],
  capabilityIds: string[],
): CapabilityEnvRequirement[] {
  const selected = new Set(capabilityIds);

  return capabilities.flatMap((capability) => {
    if (!selected.has(capability.id)) {
      return [];
    }

    return (capability.requiredEnv ?? []).map((contract) => ({
      capabilityId: capability.id,
      ...contract,
      secret: contract.secret ?? false,
    }));
  });
}

export function findMissingCapabilityEnvRequirements(
  capabilities: CapabilityDefinition[],
  capabilityIds: string[],
  env: Record<string, string | undefined>,
): MissingCapabilityEnvRequirement[] {
  return collectCapabilityEnvRequirements(capabilities, capabilityIds).flatMap(
    (requirement) => {
      const presentNames = requirement.names.filter((name) => hasValue(env, name));
      const missingNames = requirement.names.filter((name) => !hasValue(env, name));

      if (requirement.match === "allOf" && missingNames.length > 0) {
        return [
          {
            ...requirement,
            missingNames,
            presentNames,
          },
        ];
      }

      if (requirement.match === "anyOf" && presentNames.length === 0) {
        return [
          {
            ...requirement,
            missingNames: requirement.names,
            presentNames,
          },
        ];
      }

      return [];
    },
  );
}

function hasValue(
  env: Record<string, string | undefined>,
  name: string,
): boolean {
  const value = env[name];
  return value !== undefined && value.trim().length > 0;
}
