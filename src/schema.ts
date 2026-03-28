import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { getAppRoot, resolveFromAppRoot } from "./paths.js";

const appRoot = getAppRoot(import.meta.url);

/** Partial shape of the vendored `apidata.js` method descriptors. */
type RawMethodInfo = {
  parameters?: {
    additionalProperties?: number;
    properties?: Record<
      string,
      {
        type?: string;
        optional?: number;
        format?: string;
      }
    >;
  };
  permissions?: unknown;
  description?: string;
  name?: string;
};

/** Partial shape of the vendored Proxmox API tree nodes. */
type RawNode = {
  path?: string;
  info?: Record<string, RawMethodInfo>;
  children?: RawNode[];
};

/** Compiled method descriptor derived from Proxmox's `api-viewer/apidata.js`. */
export interface ApiMethodDescriptor {
  method: string;
  templatePath: string;
  regex: RegExp;
  pathParams: string[];
  groupNames: string[];
  info: RawMethodInfo;
}

/** Validated endpoint match plus coerced args ready for the HTTP client layer. */
export interface ApiMatch {
  descriptor: ApiMethodDescriptor;
  pathParams: Record<string, string>;
  args: Record<string, unknown>;
}

/**
 * Converts Proxmox template paths such as `/nodes/{node}/qemu/{vmid}` into regexes.
 *
 * Source schema: `vendor/pve-docs/api-viewer/apidata.js`
 * Official viewer: https://pve.proxmox.com/pve-docs/api-viewer/index.html
 */
function pathTemplateToRegex(templatePath: string): { regex: RegExp; pathParams: string[]; groupNames: string[] } {
  const pathParams = [...templatePath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter((value): value is string => Boolean(value));
  const groupNames = pathParams.map((_, index) => `p${index}`);

  let pattern = templatePath.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  pathParams.forEach((paramName, index) => {
    pattern = pattern.replace(`\\{${paramName}\\}`, `(?<${groupNames[index]}>[^/]+)`);
  });

  return {
    regex: new RegExp(`^${pattern}$`),
    pathParams,
    groupNames,
  };
}

/**
 * Coerces MCP/JSON input into the primitive types expected by Proxmox form fields.
 *
 * Proxmox uses form-encoded parameters in much of `/api2/json`, including special
 * cases like `pve-command-batch` that must be serialized as JSON text.
 */
function coerceValue(type: string | undefined, format: string | undefined, value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (format === "pve-command-batch" && Array.isArray(value)) {
    return JSON.stringify(value);
  }

  switch (type) {
    case "integer":
      return typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
    case "number":
      return typeof value === "number" ? value : Number.parseFloat(String(value));
    case "boolean":
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        return value !== 0;
      }
      return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
    case "string":
      if (typeof value === "object") {
        return JSON.stringify(value);
      }
      return String(value);
    default:
      return value;
  }
}

/** Matches concrete indexed arguments like `hostpci0` against schema keys like `hostpci[n]`. */
function resolveSchemaProperty(
  actualName: string,
  properties: Record<string, { type?: string; optional?: number; format?: string }>,
): { schemaName: string; property: { type?: string; optional?: number; format?: string } } | undefined {
  const exact = properties[actualName];
  if (exact) {
    return { schemaName: actualName, property: exact };
  }

  for (const [schemaName, property] of Object.entries(properties)) {
    if (!schemaName.includes("[n]")) {
      continue;
    }

    const pattern = `^${schemaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\[n\\]", "\\d+")}$`;
    if (new RegExp(pattern).test(actualName)) {
      return { schemaName, property };
    }
  }

  return undefined;
}

/**
 * Loads and validates the vendored Proxmox API schema.
 *
 * This class is the repo's contract layer between generic MCP tools and Proxmox's
 * documented REST surface:
 * https://pve.proxmox.com/wiki/Proxmox_VE_API
 */
export class ApiCatalog {
  private readonly descriptors: ApiMethodDescriptor[];

  constructor(schemaPath = process.env.PVE_DOCS_SCHEMA_PATH ?? resolveFromAppRoot(appRoot, "vendor/pve-docs/api-viewer/apidata.js")) {
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Proxmox API schema not found: ${schemaPath}`);
    }

    const raw = fs.readFileSync(schemaPath, "utf8");
    const sandbox: { apiSchema?: RawNode[] } = {};
    vm.runInNewContext(`${raw}\nthis.apiSchema = apiSchema;`, sandbox);

    const roots = sandbox.apiSchema ?? [];
    const descriptors: ApiMethodDescriptor[] = [];
    const walk = (nodes: RawNode[]) => {
      for (const node of nodes) {
        if (node.path && node.info) {
          for (const [method, info] of Object.entries(node.info)) {
            const { regex, pathParams, groupNames } = pathTemplateToRegex(node.path);
            descriptors.push({
              method,
              templatePath: node.path,
              regex,
              pathParams,
              groupNames,
              info,
            });
          }
        }
        walk(node.children ?? []);
      }
    };

    walk(roots);
    this.descriptors = descriptors;
  }

  /** Finds a matching documented endpoint for an actual HTTP method and path. */
  find(method: string, actualPath: string): ApiMatch {
    const normalizedMethod = method.toUpperCase();
    for (const descriptor of this.descriptors) {
      if (descriptor.method !== normalizedMethod) {
        continue;
      }

      const match = descriptor.regex.exec(actualPath);
      if (!match) {
        continue;
      }

      // Path placeholders are supplied by the URL itself, so the arg object only pre-seeds
      // non-path parameters documented on the method descriptor.
      const pathParams = Object.fromEntries(
        descriptor.pathParams.map((name, index) => [name, match.groups?.[descriptor.groupNames[index] ?? ""] ?? ""]),
      );
      const args = Object.fromEntries(
        Object.entries(descriptor.info.parameters?.properties ?? {})
          .filter(([name]) => !descriptor.pathParams.includes(name))
          .map(([name]) => [name, undefined]),
      );

      return { descriptor, pathParams, args };
    }

    throw new Error(`No Proxmox API endpoint matches ${normalizedMethod} ${actualPath}`);
  }

  /** Validates and coerces user input against the matching Proxmox schema entry. */
  validate(method: string, actualPath: string, inputArgs: Record<string, unknown> | undefined): ApiMatch {
    const matched = this.find(method, actualPath);
    const properties = matched.descriptor.info.parameters?.properties ?? {};
    const additionalProperties = matched.descriptor.info.parameters?.additionalProperties ?? 1;
    const args = { ...(inputArgs ?? {}) };

    if (additionalProperties === 0) {
      for (const key of Object.keys(args)) {
        if (!resolveSchemaProperty(key, properties)) {
          throw new Error(`Unknown parameter '${key}' for ${method.toUpperCase()} ${matched.descriptor.templatePath}`);
        }
      }
    }

    for (const [name, property] of Object.entries(properties)) {
      if (matched.descriptor.pathParams.includes(name)) {
        continue;
      }

      const value = args[name];
      if (value === undefined) {
        if (property.optional !== 1) {
          throw new Error(`Missing required parameter '${name}' for ${method.toUpperCase()} ${matched.descriptor.templatePath}`);
        }
        continue;
      }

      args[name] = coerceValue(property.type, property.format, value);
    }

    for (const [actualName, value] of Object.entries(args)) {
      if (matched.descriptor.pathParams.includes(actualName) || value === undefined || actualName in properties) {
        continue;
      }

      const resolved = resolveSchemaProperty(actualName, properties);
      if (!resolved) {
        continue;
      }

      args[actualName] = coerceValue(resolved.property.type, resolved.property.format, value);
    }

    return {
      descriptor: matched.descriptor,
      pathParams: matched.pathParams,
      args,
    };
  }
}
