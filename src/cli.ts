import Docker from "dockerode";
import { isValidTemplateName } from "./models/template.js";
import { DockerTemplateRepository } from "./repositories/templateRepository.js";

const USAGE = `usage:
  agentbox template build <name> <path/to/Dockerfile>   build an image FROM the base image with extra packages
  agentbox template list                                 show the templates Docker knows about`;

const [group, command, ...args] = process.argv.slice(2);
const templates = new DockerTemplateRepository(new Docker());

if (group === "template" && command === "build" && args.length === 2) {
  const [name, dockerfile] = args as [string, string];
  if (!isValidTemplateName(name)) {
    console.error(`template name "${name}" must be lowercase letters, digits, dot, dash or underscore`);
    process.exit(1);
  }
  const built = await templates.build(name, dockerfile, (line) => console.log(line));
  console.log(`built template "${built.name}" as image ${built.image}`);
} else if (group === "template" && command === "list" && args.length === 0) {
  for (const t of await templates.list()) console.log(`${t.name}\t${t.image}`);
} else {
  console.error(USAGE);
  process.exit(1);
}
