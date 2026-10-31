// A template is a Docker image with pre-installed packages, built FROM the base image.
export interface Template {
  name: string;
  image: string;
}

export const DEFAULT_TEMPLATE = "default";

// Lowercase, digits, dot, dash and underscore; at most 64 characters.
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidTemplateName(name: string): boolean {
  return NAME.test(name);
}

export function templateImage(name: string): string {
  return `agentbox/${name}:latest`;
}
